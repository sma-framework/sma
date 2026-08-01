/**
 * Tests for the roster front's auth + closed route table (Phase 9.5 Plan 08, Tasks 1 & 3).
 *
 * The FIRST sanctioned inbound surface must prove the inverted-notify posture:
 *   - token on EVERY route — the sweep is DERIVED from the frozen table itself, so a
 *     route added without a gate cannot hide behind a stale literal list,
 *   - the closed table (a non-allowlisted path → 404 with no route reflection; a bad
 *     dynamic segment → 400), ROUTES↔HANDLERS one-to-one, and the route COUNT asserted
 *     in exactly ONE place in the tree (this file),
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
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  createFrontServer,
  ROUTES,
  HANDLERS,
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
import { addProject, renameProject, selectProject } from '../src/config.mjs'

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

/**
 * Every route of the frozen table as a concrete {method, path} pair, DERIVED from ROUTES
 * (never a hand-kept literal list): the dynamic segments are filled with a valid id and a
 * valid flat asset name. A route added to the table joins every sweep below automatically
 * — that is the point.
 */
const ALL_ROUTES: Array<{ method: string; path: string; key: string }> = Object.keys(ROUTES).map((key) => {
  const [method, pattern] = key.split(' ')
  return { method, key, path: pattern.replace(':id', 'R-1').replace(':file', 'app-abc123.js') }
})

/**
 * The routes declared by the V5.1 freeze and not yet filled — each answers 501 until its
 * own plan lands: machines + chat in 9.7-15, import + onboarding in 9.7-20. Delete an
 * entry here in the SAME commit that fills its handler; the table itself does NOT change
 * (no route is added or removed by a fill plan). The static + project group left this
 * list when their handlers landed.
 */
const UNFILLED_ROUTES = [
  'GET /api/machines',
  'POST /api/machine/pair',
  'POST /api/machine/add',
  'POST /api/machine/remove',
  'POST /api/chat',
  'GET /api/chat/history',
  'POST /api/import/scan',
  'POST /api/import/enroll',
  'GET /api/onboarding',
  'POST /api/onboarding/answer',
  'POST /api/onboarding/complete',
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

describe('server.mjs — the closed THIRTY-route table', () => {
  // THE ONE PLACE the size of the surface is written down. If this number ever needs to
  // change again, that change is a declared re-freeze revision, not a routine edit.
  it('the frozen table has EXACTLY thirty routes (D-9.7-09)', () => {
    expect(Object.keys(ROUTES)).toHaveLength(30)
    expect(Object.isFrozen(ROUTES)).toBe(true)
  })

  it('ROUTES↔HANDLERS is one-to-one: no route without a handler, no handler without a route', () => {
    const routeHandlers = new Set(Object.values(ROUTES))
    const declared = new Set(Object.keys(HANDLERS))
    for (const [route, name] of Object.entries(ROUTES)) {
      expect(typeof HANDLERS[name], `${route} → ${name}`).toBe('function')
    }
    for (const name of declared) {
      expect(routeHandlers.has(name), `handler ${name} has no route`).toBe(true)
    }
    expect(declared.size).toBe(routeHandlers.size)
    expect(Object.isFrozen(HANDLERS)).toBe(true)
  })

  it('the still-unfilled routes are all real entries of the frozen table', () => {
    for (const key of UNFILLED_ROUTES) expect(ROUTES[key], key).toBeTruthy()
    expect(UNFILLED_ROUTES).toHaveLength(new Set(UNFILLED_ROUTES).size)
  })

  it('matchRoute resolves the dynamic segments and rejects a bad shape', () => {
    expect(matchRoute('GET', '/api/task/R-123')).toMatchObject({ handler: 'handleTask', params: { id: 'R-123' } })
    expect(matchRoute('GET', '/api/diff/BL-9')).toMatchObject({ handler: 'handleDiff', params: { id: 'BL-9' } })
    expect(matchRoute('GET', '/api/task/bad$id')).toEqual({ badId: true })
    expect(matchRoute('GET', `/api/task/${'x'.repeat(65)}`)).toEqual({ badId: true })
    expect(matchRoute('GET', '/api/exec')).toBeNull()
  })

  it('an asset name is FLAT: traversal and nesting die at the name parse, not in a handler', () => {
    expect(matchRoute('GET', '/assets/index-B7f2.js')).toMatchObject({
      handler: 'handleAsset',
      params: { file: 'index-B7f2.js' },
    })
    expect(matchRoute('GET', '/assets/../daemon/config.json')).toEqual({ badId: true })
    expect(matchRoute('GET', '/assets/..')).toEqual({ badId: true })
    expect(matchRoute('GET', '/assets/nested/app.js')).toEqual({ badId: true })
    expect(matchRoute('GET', '/assets/.env')).toEqual({ badId: true })
  })
})

describe('server.mjs — auth gate on every route', () => {
  const front = createFrontServer({ config: { token: TOKEN } })

  it('EVERY route of the frozen table returns 401 unauthenticated — stubs included, 401 BEFORE 501', async () => {
    // A distinct remote per call so the failure-window limiter never masks a 401 as a 429.
    let n = 0
    const swept: string[] = []
    for (const r of ALL_ROUTES) {
      const res = await call(front, { method: r.method, url: r.path, remote: `10.1.0.${n++}` })
      // An unfilled route must NOT answer 501 here: authorization runs before the stub, so
      // an anonymous caller cannot map which routes exist by their status code.
      expect(res.statusCode, `${r.method} ${r.path}`).toBe(401)
      swept.push(r.key)
    }
    // the sweep is the WHOLE table — a new route cannot slip past by not being listed
    expect(swept.sort()).toEqual(Object.keys(ROUTES).sort())
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

// ── Plan 9.5-11: the five D-9.5-09 harness handlers (filled a slot, added no route) ──

const jsonHeaders = () => ({ ...bearer(), 'content-type': 'application/json' })

describe('server.mjs — the harness routes still fill a FROZEN slot (no route added)', () => {
  it('the five harness routes are handlers, not 501 stubs', () => {
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

// ── the D-9.7-09 sixteen: declared, gated, and honestly 501 until their own plan ──
//
// Every case below is DELETED (one line at a time) by the plan that fills its handler:
// static + projects in 9.7-09, machines + chat in 9.7-15, import + onboarding in 9.7-20.
// The table itself never changes — a fill plan replaces a stub, it does not add a route.

describe('server.mjs — the unfilled routes answer 501 when authenticated', () => {
  const front = createFrontServer({ config: { token: TOKEN } })

  it('an AUTHED request to each still-unfilled route → 501', async () => {
    for (const key of UNFILLED_ROUTES) {
      const [method, pattern] = key.split(' ')
      const path = pattern.replace(':file', 'app-abc123.js')
      const res = await call(front, { method, url: path, headers: jsonHeaders() })
      expect(res.statusCode, key).toBe(501)
    }
  })

  it('a stub never reads the request body: a hostile POST body still yields a bare 501', async () => {
    const res = await call(front, {
      method: 'POST',
      url: '/api/import/scan',
      headers: jsonHeaders(),
      body: { command: 'rm -rf /', path: '../../etc/passwd' },
    })
    expect(res.statusCode).toBe(501)
    expect(res.body).toBe('not implemented') // no echo, no field name, no oracle
  })
})

// ── the `machine` field: another machine is an ADDRESSEE, never another door (D-9.7-07) ──

describe('server.mjs — the optional machine field on enqueue/approve/return', () => {
  const adapter = { list: async () => [], enqueue: async (t: any) => ({ id: t.id }) }
  const mkFront = () =>
    createFrontServer({
      config: { token: TOKEN },
      deps: { adapter, casExec: makeCasExec('awaiting_approval'), verbRunner: async () => ({ merged: true }), clock: () => 1 },
    })

  it('a URL in `machine` → 400: the field is an identifier, the address is resolved server-side', async () => {
    for (const url of ['/api/enqueue', '/api/approve', '/api/return']) {
      const res = await call(mkFront(), {
        method: 'POST',
        url,
        headers: jsonHeaders(),
        body: { taskId: 'R-1', title: 'x', lane: 'prod', machine: 'http://192.168.1.50:7777' },
      })
      expect(res.statusCode, url).toBe(400)
    }
  })

  it('a well-formed machine id → 501 (the door exists, the peer is wired in 9.7-15) — never a silent local run', async () => {
    const enqueued: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: { list: async () => [], enqueue: async (t: any) => (enqueued.push(t), { id: t.id }) }, clock: () => 1 },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: jsonHeaders(),
      body: { title: 'сделай отчёт', lane: 'prod', machine: 'mac-mini' },
    })
    expect(res.statusCode).toBe(501)
    expect(enqueued).toHaveLength(0) // it did NOT quietly run here instead
  })

  it('an unknown key on an action body is still rejected before anything runs', async () => {
    const res = await call(mkFront(), {
      method: 'POST',
      url: '/api/enqueue',
      headers: jsonHeaders(),
      body: { title: 'x', lane: 'prod', machines: 'mac-mini' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── Plan 9.7-09 Task 1: the daemon serves the built SPA itself (D-9.7-04) ──
//
// «The app rides with the daemon»: the SAME process, behind the SAME token, with NO second
// web server. The file system is an injected seam (deps.fsImpl + deps.staticDir), so these
// cases never touch the real tree — except the ONE smoke at the bottom, which reads the
// real build when a build is present and skips itself when it is not.

/** A file system that SHOUTS if it is ever reached — the traversal proof (T-9.7-21). */
function shoutingFs() {
  const calls: string[] = []
  return {
    calls,
    readFileSync: (p: any) => {
      calls.push(String(p))
      throw new Error(`the file system must NEVER be reached for a rejected asset name (got ${p})`)
    },
  }
}

describe('server.mjs — GET / serves the built app', () => {
  it('serves the built index.html with a no-cache header (the app updates without a manual purge)', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { staticDir: '/built', fsImpl: { readFileSync: () => '<!doctype html><title>СМА</title>' } },
    })
    const res = await call(front, { url: '/', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.body).toContain('СМА')
  })

  it('NO build yet → 200 with the one-line build instruction, never a 500 and never a blank', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        staticDir: '/built',
        fsImpl: {
          readFileSync: () => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          },
        },
      },
    })
    const res = await call(front, { url: '/', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(/npm run build/)
  })

  it('is still behind the token: an anonymous GET / is a 401, build or no build', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { staticDir: '/built', fsImpl: { readFileSync: () => '<html>secret</html>' } },
    })
    const res = await call(front, { url: '/', remote: '10.44.0.1' })
    expect(res.statusCode).toBe(401)
    expect(res.body).not.toContain('secret')
  })
})

describe('server.mjs — GET /assets/:file', () => {
  it('serves a hashed bundle with its content-type and an immutable cache header', async () => {
    const read: string[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        staticDir: '/built',
        fsImpl: {
          readFileSync: (p: any) => {
            read.push(String(p))
            return Buffer.from('console.log(1)')
          },
        },
      },
    })
    const js = await call(front, { url: '/assets/index-B7f2aQ.js', headers: bearer() })
    expect(js.statusCode).toBe(200)
    expect(js.headers['content-type']).toMatch(/javascript/)
    expect(js.headers['cache-control']).toMatch(/immutable/)
    expect(js.body).toBe('console.log(1)')
    // the read stayed inside the build directory — a flat name joined to static/app/assets
    expect(read[0]).toMatch(/index-B7f2aQ\.js$/)

    const css = await call(front, { url: '/assets/index-D-H8.css', headers: bearer() })
    expect(css.headers['content-type']).toMatch(/text\/css/)
  })

  it('a missing asset → 404 (not a 500, not an empty 200)', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        staticDir: '/built',
        fsImpl: {
          readFileSync: () => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          },
        },
      },
    })
    const res = await call(front, { url: '/assets/gone-1234.js', headers: bearer() })
    expect(res.statusCode).toBe(404)
  })

  it('an asset is behind the token too — anonymous → 401, never the bundle', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { staticDir: '/built', fsImpl: { readFileSync: () => 'BUNDLE' } },
    })
    const res = await call(front, { url: '/assets/index-B7f2aQ.js', remote: '10.45.0.1' })
    expect(res.statusCode).toBe(401)
    expect(res.body).not.toContain('BUNDLE')
  })

  it('TRAVERSAL dies at the name parse: the file system is never reached (T-9.7-21)', async () => {
    const fs = shoutingFs()
    const front = createFrontServer({ config: { token: TOKEN }, deps: { staticDir: '/built', fsImpl: fs } })
    for (const url of [
      '/assets/nested/app.js', // a separator
      '/assets/..%2fsecrets', // an encoded separator
      '/assets/%2e%2e%2fconfig.json', // fully encoded «../»
      '/assets/.env', // a leading dot
      '/assets/a%20b.js', // a space
      `/assets/${'x'.repeat(200)}.js`, // over the length cap
    ]) {
      const res = await call(front, { url, headers: bearer() })
      expect(res.statusCode, url).toBe(400)
    }
    expect(fs.calls, `fs was reached for: ${fs.calls.join(', ')}`).toHaveLength(0)
  })
})

// ── the ONE smoke that reads the real build (skipped when there is no build) ──

const BUILT_APP_DIR = fileURLToPath(new URL('../static/app/', import.meta.url))
const HAS_BUILD = existsSync(`${BUILT_APP_DIR}index.html`)

// ── Plan 9.7-09 Task 2: the project doors + the decision journal on the task card ──
//
// The four project routes do NOT re-implement a single rule of the registry: they reject
// unknown keys, hand the body to the config.mjs door (addProject / renameProject /
// selectProject — the REAL ones are wired below, not fakes), map the named error and emit
// a hint. The id is minted by the door and never moves on a rename.

/** A file system that captures the atomic config write instead of touching the disk. */
function capturingConfigFs() {
  const written: any[] = []
  return {
    written,
    mkdirSync: () => undefined,
    writeFileSync: (_p: any, text: any) => written.push(JSON.parse(String(text))),
    renameSync: () => undefined,
    chmodSync: () => undefined,
  }
}

const PROJECT_ENV = { SMA_DAEMON_CONFIG: '/nowhere/sma-daemon/config.json' }

/** A config whose federation block carries REAL peer tokens — the leak fixture. */
function configWithPeers() {
  return {
    token: TOKEN,
    workers: [],
    projects: [{ id: 'sma', name: 'СМА' }],
    activeProject: 'sma',
    federation: { role: 'hub', peers: [{ id: 'mac-mini', url: 'http://10.0.0.5:7777', token: 'peer-secret-token' }] },
  }
}

describe('server.mjs — GET /api/projects', () => {
  it('serves the registry slice and NOT one byte of a secret', async () => {
    const deriveState = async () => ({
      projects: [{ id: 'sma', name: 'СМА', taskCounts: { queued: 1, total: 1 } }],
      activeProject: 'sma',
      federation: { role: 'hub', peers: [{ id: 'mac-mini', token: 'peer-secret-token' }] },
      queue: [],
    })
    const front = createFrontServer({ config: configWithPeers(), deps: { deriveState } })
    const res = await call(front, { url: '/api/projects', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.projects[0]).toMatchObject({ id: 'sma', name: 'СМА' })
    expect(out.activeProject).toBe('sma')
    expect(res.body).not.toContain('peer-secret-token')
    expect(res.body).not.toContain(TOKEN)
  })
})

describe('server.mjs — the project write doors delegate to the config registry', () => {
  const mkFront = (config: any, fsImpl: any) =>
    createFrontServer({
      config,
      deps: { addProject, renameProject, selectProject, env: PROJECT_ENV, fsImpl },
    })

  it('POST /api/project/add takes a folder into the register, id minted by the door', async () => {
    const fsImpl = capturingConfigFs()
    const config: any = { token: TOKEN, workers: [], projects: [], activeProject: null }
    const res = await call(mkFront(config, fsImpl), {
      method: 'POST',
      url: '/api/project/add',
      headers: jsonHeaders(),
      body: { path: '/Users/f/projects/mass-platform', name: 'Платформа' },
    })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.ok).toBe(true)
    expect(out.project.name).toBe('Платформа')
    expect(out.project.id).toMatch(/^[a-z0-9-]{1,64}$/) // a slug, minted by config.mjs
    // it reached the durable write, and the folder the founder picked was kept
    const stored = fsImpl.written[fsImpl.written.length - 1]
    expect(stored.projects).toHaveLength(1)
    expect(stored.projects[0].path).toBe('/Users/f/projects/mass-platform')
    // the in-memory config the next read serves is not stale
    expect(config.projects).toHaveLength(1)
  })

  it('a name-less add still works: the folder name becomes the project name', async () => {
    const fsImpl = capturingConfigFs()
    const config: any = { token: TOKEN, workers: [], projects: [], activeProject: null }
    const res = await call(mkFront(config, fsImpl), {
      method: 'POST',
      url: '/api/project/add',
      headers: jsonHeaders(),
      body: { path: '/Users/f/projects/sma-dev' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).project.name).toBe('sma-dev')
  })

  it('POST /api/project/rename moves the NAME and never the id (D-9.7-08)', async () => {
    const fsImpl = capturingConfigFs()
    const config: any = { token: TOKEN, workers: [], projects: [{ id: 'sma', name: 'СМА' }], activeProject: 'sma' }
    const res = await call(mkFront(config, fsImpl), {
      method: 'POST',
      url: '/api/project/rename',
      headers: jsonHeaders(),
      body: { id: 'sma', name: 'СМА — продукт' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).project).toEqual({ id: 'sma', name: 'СМА — продукт' })
    expect(config.projects[0].id).toBe('sma') // the key tasks reference did NOT move
  })

  it('POST /api/project/select switches the active project; an unknown id → 404', async () => {
    const fsImpl = capturingConfigFs()
    const config: any = {
      token: TOKEN,
      workers: [],
      projects: [{ id: 'sma', name: 'СМА' }, { id: 'platform', name: 'Платформа' }],
      activeProject: 'sma',
    }
    const front = mkFront(config, fsImpl)
    const ok = await call(front, {
      method: 'POST',
      url: '/api/project/select',
      headers: jsonHeaders(),
      body: { id: 'platform' },
    })
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body).activeProject).toBe('platform')
    expect(config.activeProject).toBe('platform')

    const ghost = await call(front, {
      method: 'POST',
      url: '/api/project/select',
      headers: jsonHeaders(),
      body: { id: 'ghost' },
    })
    expect(ghost.statusCode).toBe(404)
  })

  it('a rename of an unknown project → 404 (the named error of the door maps)', async () => {
    const res = await call(mkFront({ token: TOKEN, workers: [], projects: [] }, capturingConfigFs()), {
      method: 'POST',
      url: '/api/project/rename',
      headers: jsonHeaders(),
      body: { id: 'ghost', name: 'x' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('an unknown key on a project body → 400 BEFORE the door is called (zero door calls)', async () => {
    const calls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN, workers: [], projects: [] },
      deps: {
        addProject: (...a: any[]) => (calls.push(a), { projects: [] }),
        selectProject: (...a: any[]) => (calls.push(a), { projects: [] }),
        env: PROJECT_ENV,
      },
    })
    const add = await call(front, {
      method: 'POST',
      url: '/api/project/add',
      headers: jsonHeaders(),
      body: { path: '/p', name: 'x', command: 'rm -rf /' },
    })
    expect(add.statusCode).toBe(400)
    const select = await call(front, {
      method: 'POST',
      url: '/api/project/select',
      headers: jsonHeaders(),
      body: { id: 'sma', repoDir: '/etc' },
    })
    expect(select.statusCode).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('an empty registry write door that is not wired → 501, never a silent no-op', async () => {
    const front = createFrontServer({ config: { token: TOKEN, projects: [] } })
    const res = await call(front, {
      method: 'POST',
      url: '/api/project/add',
      headers: jsonHeaders(),
      body: { path: '/p' },
    })
    expect(res.statusCode).toBe(501)
  })
})

// ── the decision journal on the task card (the three layers, BL law of three layers) ──

describe('server.mjs — GET /api/task/:id carries the decision journal', () => {
  const adapter = { list: async () => [{ id: 'R-9', title: 'ночная задача', lane: 'prod', status: 'completed', attempt: 2 }] }

  it('three layers ride the payload: why it was routed, what was chosen, what was read', async () => {
    const ledger = {
      readAttempts: () => [{ attempt: 1, workerId: 'max-1', outcome: 'failed' }, { attempt: 2, workerId: 'max-2', outcome: 'completed' }],
      readJournalEntries: () => [
        {
          taskId: 'R-9',
          attempt: 1,
          attemptId: 'R-9#1',
          layer: 'dispatcher',
          payload: { code: 'lane_default', lane: 'prod', workerId: 'max-1' },
          recordedAt: '2026-08-01T01:00:00.000Z',
        },
        {
          taskId: 'R-9',
          attempt: 2,
          attemptId: 'R-9#2',
          layer: 'approach',
          payload: { approach: 'взял существующий писатель конфига', rejected: ['свой писатель'] },
          recordedAt: '2026-08-01T02:00:00.000Z',
        },
        {
          taskId: 'R-9',
          attempt: 2,
          attemptId: 'R-9#2',
          layer: 'memory',
          payload: { notes: ['reference_sma_dev_workspace'], reflexes: ['no-new-store'] },
          recordedAt: '2026-08-01T02:00:01.000Z',
        },
      ],
    }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, ledger } })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    // (a) the dispatcher layer: a CODE plus the подпись the card renders
    expect(out.journal.dispatcher[0]).toMatchObject({ code: 'lane_default', ts: '2026-08-01T01:00:00.000Z' })
    expect(out.journal.dispatcher[0].label).toBe('маршрут по умолчанию для полосы')
    // (b) the approach note rides its OWN attempt, not the task
    expect(out.attempts[1].approachNote).toBe('взял существующий писатель конфига')
    expect(out.attempts[0].approachNote).toBeUndefined()
    // (c) the memory layer is IDS ONLY
    expect(out.journal.memoryTrace).toEqual({ notes: ['reference_sma_dev_workspace'], reflexes: ['no-new-store'] })
  })

  it('a task older than the journal → EMPTY layers, never an error', async () => {
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, ledger: { readAttempts: () => [] } } })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.journal).toEqual({ dispatcher: [], memoryTrace: { notes: [], reflexes: [] } })
  })
})

// ── the carried tail of the state read: the project filter reaches the derive ──

describe('server.mjs — ?project= narrows a state read', () => {
  it('passes the filter through to the derive, and passes nothing when it is absent', async () => {
    const seen: any[] = []
    const deriveState = async (d: any) => (seen.push(d.project), { queue: [], done: [{ id: 'R-1' }] })
    const front = createFrontServer({ config: { token: TOKEN }, deps: { deriveState } })
    await call(front, { url: '/api/state?project=platform', headers: bearer() })
    await call(front, { url: '/api/state', headers: bearer() })
    await call(front, { url: '/api/done?project=platform', headers: bearer() })
    expect(seen).toEqual(['platform', undefined, 'platform'])
  })

  it('an over-long project filter is dropped rather than carried into the derive', async () => {
    const seen: any[] = []
    const deriveState = async (d: any) => (seen.push(d.project), { queue: [] })
    const front = createFrontServer({ config: { token: TOKEN }, deps: { deriveState } })
    await call(front, { url: `/api/state?project=${'p'.repeat(200)}`, headers: bearer() })
    expect(seen).toEqual([undefined])
  })
})

describe('server.mjs — the real built tree (skipped when `cd spa && npm run build` has not run)', () => {
  it.skipIf(!HAS_BUILD)('serves the real index.html and a real hashed bundle off the disk', async () => {
    const front = createFrontServer({ config: { token: TOKEN } })
    const index = await call(front, { url: '/', headers: bearer() })
    expect(index.statusCode).toBe(200)
    expect(index.body).toMatch(/<!doctype html>/i)

    const asset = readdirSync(`${BUILT_APP_DIR}assets`).find((f) => f.endsWith('.js'))
    expect(asset, 'a Vite build always emits at least one .js bundle').toBeTruthy()
    const res = await call(front, { url: `/assets/${asset}`, headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/javascript/)
  })
})
