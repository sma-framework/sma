/**
 * Tests for the roster front's auth + closed route table.
 *
 * The FIRST sanctioned inbound surface must prove the inverted-notify posture:
 *   - token on EVERY route — the sweep is DERIVED from the frozen table itself, so a
 *     route added without a gate cannot hide behind a stale literal list,
 *   - the closed table (a non-allowlisted path → 404 with no route reflection; a bad
 *     dynamic segment → 400), ROUTES↔HANDLERS one-to-one, and the route COUNT, whose
 *     canonical assertion lives HERE (three feature suites re-state it as their own «my
 *     feature added no route» guard, and none of them may be the place it is decided),
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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createFrontServer,
  ROUTES,
  HANDLERS,
  PENDING_ROUTES,
  matchRoute,
} from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'
import { QueueEncodingError } from '../src/queue/encoding.mjs'
import {
  authed,
  tokenEquals,
  sessionCookie,
  parseCookies,
  createFailureLimiter,
  COOKIE_NAME,
} from '../src/front/auth.mjs'
import { addProject, renameProject, selectProject } from '../src/config.mjs'
import { applyAgentToggle } from '../src/front/harness.mjs'

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
 * The bare-stub shape a declared-but-unfilled route has: a handler whose whole body is
 * `send501(res)`. The V5.1 freeze declared sixteen of them at once so every screen was built
 * against the final contract, and every one has since been filled; the V5.4 freeze declared
 * twenty-three more the same way, and those are being filled one at a time.
 *
 * While that batch was being filled, the shape alone was not the whole guard: «is this handler
 * a stub» had to be asked together with «is its route declared pending». EVERY SLOT IS FILLED
 * NOW, so the shape is the whole guard again — the case below passes an empty Set literal and
 * asks no list for permission. The mechanism stays demonstrated in its own case, because the
 * next growth wave will need it.
 */
const BARE_STUB = /\)\s*\{\s*(return\s+)?send501\(res\)\s*;?\s*\}\s*$/

/**
 * The KEYS of the V5.4 section of the route table, read out of server.mjs ITSELF rather than
 * copied into this file: a hand-kept second list is a hand-kept second truth, and this one
 * exists precisely to catch a key that does not belong. The section is delimited by its own
 * marker comment and ends where the ROUTES literal does.
 */
const V54_SECTION_KEYS: Set<string> = (() => {
  const src = readFileSync(fileURLToPath(new URL('../src/front/server.mjs', import.meta.url)), 'utf8')
  const marker = '// ── the V5.4 growth (declared here, filled one at a time) ──'
  const start = src.indexOf(marker)
  if (start < 0) throw new Error('the V5.4 section marker is missing from server.mjs')
  // The section ends where the NEXT section begins, or where the literal does. A later door
  // declared under its own marker is not part of this one — without this the section would
  // silently swallow every route ever added after it, and its size would stop meaning anything.
  const literalEnd = src.indexOf('\n})', start)
  const nextSection = src.indexOf('\n  // ──', start + marker.length)
  const end = nextSection > 0 && nextSection < literalEnd ? nextSection : literalEnd
  const section = src.slice(start, end)
  return new Set([...section.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]))
})()

/**
 * bareStubsOutside(handlers, routes, pending) — every handler that is a bare 501 AND whose
 * route is not declared pending, i.e. every route that rotted back into a stub.
 *
 * It is a pure function so the very same predicate can be pointed at a deliberately broken
 * fixture below. A guard nobody has ever watched fail is a guard nobody knows the shape of —
 * and this one replaced a guard («ZERO stubs, full stop») that could not survive the V5.4
 * declaration, so its teeth are worth showing.
 */
function bareStubsOutside(
  handlers: Record<string, any>,
  routes: Record<string, string>,
  pending: Set<string>,
): string[] {
  const pendingHandlers = new Set([...pending].map((key) => routes[key]))
  return Object.entries(handlers)
    .filter(([name, fn]) => BARE_STUB.test(String(fn)) && !pendingHandlers.has(name))
    .map(([name]) => name)
}

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

describe('server.mjs — the closed FIFTY-SEVEN-route table', () => {
  // THE ONE PLACE the size of the surface is written down. If this number ever needs to
  // change again, that change is a declared re-freeze revision, not a routine edit. FILLING
  // a declared slot does not change it — that is the entire point of declaring them all at
  // once, and it is why no fill plan of the release has to come back and edit this line.
  // RE-FREEZE REVISION (phase «Двигатель», 11.08.2026): 53 of the V5.4 freeze
  // + POST /api/chat/stop (Стоп) + POST /api/redirect (руль бегущей задачи). Declared, not drifted.
  // RE-FREEZE REVISION (13.08.2026): + POST /api/batch — one request of the owner fans out
  // into the work it names. A batch is a fact of the QUEUE, and something has to write it.
  // RE-FREEZE REVISION (13.08.2026, the same day): + POST /api/batch/decide — a broken piece
  // stops its assembly and asks its owner (пропустить / повторить / отменить). A question with
  // no door to answer it through is a question the machine is asking itself.
  // RE-FREEZE REVISION (13.08.2026, the same day, third): + POST /api/task/suggest and
  // POST /api/task/words — the system proposes the words of a task and its owner corrects
  // them. The first door WRITES NOTHING; the second writes only while the work is not over.
  // RE-FREEZE REVISION (13.08.2026, the same day, fourth): + POST /api/batch/suggest — the
  // composition a phrase COULD have, proposed for confirmation. It writes nothing either: the
  // batch is still put in through POST /api/batch, by its owner's own press.
  // RE-FREEZE REVISION (13.08.2026, the same day, fifth): + POST /api/wave/hold — «останови
  // волну 2». A stop is a WORD SOMEBODY SAID: nothing in the queue derives it, so it needs a
  // door to be said through and a register on disk to be remembered in.
  it('the frozen table has EXACTLY sixty-one routes', () => {
    expect(Object.keys(ROUTES)).toHaveLength(61)
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

  /**
   * ZERO STUBS, UNCONDITIONALLY — and the load-bearing detail is what is NOT passed in.
   *
   * While the release was being filled this asked `PENDING_ROUTES`, so a bare 501 was
   * legitimate for a declared-pending route and a defect for any other. Every slot is filled
   * now and that Set is empty — so this passes an EMPTY SET LITERAL instead of the constant.
   * The difference is the whole point: reading the constant, anyone could re-license a stub by
   * adding one key; reading a literal, the law has no door left to be weakened through.
   *
   * The constant is deliberately KEPT (see its note in server.mjs). Across this suite every
   * fill plan left an assertion that its own key is gone from it — those proofs need it to
   * exist. It is a record of how the batch was grown, not a licence.
   */
  it('ZERO STUBS, UNCONDITIONALLY: no handler of this table is a bare 501', () => {
    expect(bareStubsOutside(HANDLERS, ROUTES, new Set())).toEqual([])
  })

  /**
   * The exception set is EMPTY, and that is asserted rather than assumed. It is the other half
   * of the law above: the test now refuses to consult this Set, so the only thing that keeps
   * the two facts in agreement — «no stubs» and «nothing is excused» — is this line.
   */
  it('the exception set is empty: nothing is declared pending any more', () => {
    expect([...PENDING_ROUTES]).toEqual([])
  })

  it('the guard BITES: a bare 501 on a route OUTSIDE the declared set is named, not tolerated', () => {
    // A stand-in written exactly as a real stub is written. It is never CALLED — only read —
    // so `send501` here is a local no-op standing in for the server's own responder.
    const send501 = (_res: unknown) => undefined
    const stub = function handleRotted({ res }: any) {
      send501(res)
    }
    // The shape is asserted BEFORE it is relied on: this fixture goes through the same
    // transpiler as the source, and a fixture that quietly stopped matching would turn the
    // two cases below into two tests that pass without testing anything.
    expect(BARE_STUB.test(String(stub))).toBe(true)

    // a LIVE door rotted back into a stub → named. An EMPTY SET LITERAL, exactly as the law
    // above uses: this case must bite under the rule as it now stands, not under whatever the
    // constant happens to hold.
    expect(bareStubsOutside({ ...HANDLERS, handleState: stub }, ROUTES, new Set())).toEqual(['handleState'])
    // The same shape on a route that IS named → silence, which is what «pending» meant. The
    // mechanism itself is still demonstrated here, against a set named for this case, because
    // the next growth wave will re-wire the shape test to a real one and this is the proof
    // that naming is what buys the silence.
    const named = new Set(['GET /api/state'])
    expect(bareStubsOutside({ ...HANDLERS, handleState: stub }, ROUTES, named)).toEqual([])
  })

  /**
   * PENDING_ROUTES may only ever SHRINK, and only ever inside the V5.4 section. Its size is
   * deliberately NOT asserted against a literal: it goes down by one every time a plan fills
   * a slot, and a test that had to be edited on every fill would be a counter to chase.
   * What IS asserted against a literal is the size of the declaration itself — the twenty-three
   * that were written down once and may not grow.
   */
  it('PENDING_ROUTES is a shrinking subset of the V5.4 section, and the section is exactly 23', () => {
    expect(Object.isFrozen(PENDING_ROUTES)).toBe(true)
    expect(V54_SECTION_KEYS.size).toBe(23)
    expect(PENDING_ROUTES.size).toBeLessThanOrEqual(V54_SECTION_KEYS.size)
    for (const key of PENDING_ROUTES) {
      expect(ROUTES[key], `${key} is pending but is not in the table at all`).toBeTruthy()
      expect(V54_SECTION_KEYS.has(key), `${key} is pending but is not part of the V5.4 section`).toBe(true)
    }
    // and the section is genuinely part of the table, not a comment that drifted off it
    for (const key of V54_SECTION_KEYS) expect(ROUTES[key], key).toBeTruthy()
  })

  it('the five last-filled handlers delegate to their engines, they do not re-implement them', () => {
    expect(String(HANDLERS.handleImportScan)).toMatch(/scanEstate/)
    expect(String(HANDLERS.handleImportEnroll)).toMatch(/enrollSelections/)
    for (const name of ['handleOnboarding', 'handleOnboardingAnswer', 'handleOnboardingComplete']) {
      expect(String(HANDLERS[name]), name).toMatch(/onboardingEngine|createOnboarding/)
    }
  })

  it('matchRoute resolves the dynamic segments and rejects a bad shape', () => {
    expect(matchRoute('GET', '/api/task/R-123')).toMatchObject({ handler: 'handleTask', params: { id: 'R-123' } })
    expect(matchRoute('GET', '/api/diff/BL-9')).toMatchObject({ handler: 'handleDiff', params: { id: 'BL-9' } })
    expect(matchRoute('GET', '/api/task/bad$id')).toEqual({ badId: true })
    expect(matchRoute('GET', `/api/task/${'x'.repeat(65)}`)).toEqual({ badId: true })
    expect(matchRoute('GET', '/api/exec')).toBeNull()
  })

  it('the two V5.4 dynamic segments keep the SAME shape: a bad id is a 400, never a 404', () => {
    expect(matchRoute('GET', '/api/phase/12')).toMatchObject({ handler: 'handlePhaseCard', params: { id: '12' } })
    expect(matchRoute('GET', '/api/attempt/R-9')).toMatchObject({ handler: 'handleAttempt', params: { id: 'R-9' } })
    // the reserved literal: «the list of phases», riding the card's own door
    expect(matchRoute('GET', '/api/phase/index')).toMatchObject({ handler: 'handlePhaseCard', params: { id: 'index' } })
    for (const bad of ['/api/phase/bad$id', '/api/attempt/bad$id', '/api/phase/../../etc/passwd']) {
      expect(matchRoute('GET', bad), bad).toEqual({ badId: true })
    }
    expect(matchRoute('GET', `/api/attempt/${'x'.repeat(65)}`)).toEqual({ badId: true })
    // the POST siblings are NOT reachable by the dynamic GET branch — a method is not an id
    expect(matchRoute('POST', '/api/phase/anything')).toBeNull()
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

  it('EVERY route of the frozen table returns 401 unauthenticated — the gate runs first', async () => {
    // A distinct remote per call so the failure-window limiter never masks a 401 as a 429.
    let n = 0
    const swept: string[] = []
    for (const r of ALL_ROUTES) {
      const res = await call(front, { method: r.method, url: r.path, remote: `10.1.0.${n++}` })
      // Authorization runs BEFORE any handler — including the ones that would answer 501
      // for a missing collaborator — so an anonymous caller cannot map the surface by
      // status code: every route of the table looks exactly the same from outside.
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

  /**
   * A queue database created in a Windows ANSI code page refuses every title that is not
   * plain ASCII. The founder types their own language, presses the button, and the whole
   * diagnosis — what happened and the one command that repairs it — used to collapse into
   * «internal error» at the dispatcher's catch-all. The request is not what is wrong here,
   * so it does not answer 400; the SERVICE cannot store this until someone migrates it.
   */
  it('a title the queue database cannot store answers with the reason, not «internal error»', async () => {
    const said =
      'the queue database sma_queue (WIN1252) cannot store this text: run node supervisor/queue-utf8-migrate.mjs --apply'
    const adapter = {
      enqueue: async () => {
        throw new QueueEncodingError(said)
      },
    }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter } })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { title: 'сделай отчёт', lane: 'prod' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('queue-utf8-migrate')
    expect(res.body).not.toContain('internal error')
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

  /**
   * «ТЕСТЫ НЕ ЗАПУСКАЛИСЬ» IS NOT «ТЕСТЫ КРАСНЫЕ», and the approval must keep telling the two
   * apart. The merge ritual now says NULL where no run happened; the door decides by the merge
   * itself, and only a real red run blocks the green outcome. The receipt travels back as it
   * is — a null the screens already read as «нет данных», never rewritten into a boolean here.
   */
  it('a merge with no test run at all still approves, and hands the null receipt back untouched', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        casExec: makeCasExec('awaiting_approval'),
        verbRunner: async (o: any) => ({ merged: true, testsPassed: null, branch: o.branch, receipt: { branch: o.branch, testsPassed: null } }),
        repoDir: '/repo',
      },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'R-78' },
    })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.merged).toBe(true)
    expect(out.receipt.testsPassed).toBe(null)
  })

  it('a merge whose tests actually went RED is not approved', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        casExec: makeCasExec('awaiting_approval'),
        verbRunner: async (o: any) => ({ merged: true, testsPassed: false, branch: o.branch, receipt: { branch: o.branch, testsPassed: false } }),
        repoDir: '/repo',
      },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'R-79' },
    })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.merged).toBe(false)
    expect(out.ok).toBe(false)
  })

  /**
   * WHERE THE MERGE HAPPENS. The worker's branch lives in the tree of the CONNECTED project;
   * the daemon may be launched from anywhere at all. Handing the merge the launch directory
   * made the button answer «ok:false, merged:false» on a real machine — the branch simply did
   * not resolve there — while the same press worked on a checkout where the two directories
   * happened to coincide. The neighbouring doors of the very same card (the commit log, the
   * diff) already resolve the tree this way; this one had been left behind.
   *
   * The assertion stands on the ARGUMENT the merge verb RECEIVED, not on the fact that it ran:
   * a wire is proven by what travels along it.
   */
  it('the merge runs in the tree that holds the branch — the connected project, not the launch directory', async () => {
    const mergeCalls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        casExec: makeCasExec('awaiting_approval'),
        verbRunner: async (o: any) => (mergeCalls.push(o), { merged: true, testsPassed: true, branch: o.branch, receipt: { branch: o.branch, testsPassed: true } }),
        repoDir: '/launch/dir',
        phaseCycleDir: () => '/connected/project',
      },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'R-81' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).merged).toBe(true)
    expect(mergeCalls[0].branch).toBe('wt/R-81')
    expect(mergeCalls[0].cwd).toBe('/connected/project')
    expect(mergeCalls[0].cwd).not.toBe('/launch/dir')
  })

  it('with nothing connected the merge falls back to the served tree', async () => {
    const mergeCalls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        casExec: makeCasExec('awaiting_approval'),
        verbRunner: async (o: any) => (mergeCalls.push(o), { merged: true, testsPassed: true, branch: o.branch }),
        repoDir: '/repo',
      },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'R-82' },
    })
    expect(res.statusCode).toBe(200)
    expect(mergeCalls[0].cwd).toBe('/repo')
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

  /**
   * A RETURN IS A STATE OF THE SAME TASK — so the row it puts back has to be called by the
   * task's own NAME. This door used to mint a heading out of the routing identifier whenever the
   * body carried no title, and the screen then drew that identifier where a person expects a
   * name, beside the original row a durable queue keeps: one task, read as two, one of them
   * nameless. The name was in the door's hands the whole time — the very rows it reads for the
   * attempt number carry it.
   *
   * The fake adapter is not richer than the library: `list` answers rows in the shapes the real
   * one returns (id/title/attempt/status/source), and `enqueue` records exactly what it was given.
   */
  const returnFront = (rows: any[], enqueued: any[]) =>
    createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: {
          list: async () => rows.slice(),
          enqueue: async (t: any) => {
            enqueued.push(t)
            return { id: t.id }
          },
        },
        casExec: makeCasExec('awaiting_approval'),
      },
    })

  const postReturn = (front: any, body: any) =>
    call(front, {
      method: 'POST',
      url: '/api/return',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body,
    })

  it('the row put back carries the task’s real name, not a heading minted from its identifier', async () => {
    const enqueued: any[] = []
    const front = returnFront(
      [{ id: 'R-5', attempt: 2, status: 'awaiting_approval', title: 'собери отчёт по расходам', source: 'roster' }],
      enqueued,
    )
    const res = await postReturn(front, { taskId: 'R-5', note: 'переделай вывод' })
    expect(res.statusCode).toBe(200)
    expect(enqueued[0].title).toBe('собери отчёт по расходам')
  })

  it('an older row minted by this very door is not inherited as a name', async () => {
    const enqueued: any[] = []
    const front = returnFront(
      [
        // the artefact of a previous return, written before the door knew the name
        { id: 'R-5', attempt: 3, status: 'queued', title: 'return:R-5', source: 'return' },
        { id: 'R-5', attempt: 2, status: 'awaiting_approval', title: 'собери отчёт по расходам', source: 'roster' },
      ],
      enqueued,
    )
    expect((await postReturn(front, { taskId: 'R-5', note: 'ещё раз' })).statusCode).toBe(200)
    expect(enqueued[0].title).toBe('собери отчёт по расходам')
  })

  it('with no name to be found anywhere the row is called by the bare id — never by a minted phrase', async () => {
    const enqueued: any[] = []
    const front = returnFront([], enqueued)
    expect((await postReturn(front, { taskId: 'R-5', note: 'переделай' })).statusCode).toBe(200)
    // the queue refuses an empty title, so the id itself is the floor — the screen already shows
    // it as an id, which is honest; a minted phrase would have claimed to be a name
    expect(enqueued[0].title).toBe('R-5')
  })

  /**
   * THE NUMBER OF THE NEXT ATTEMPT IS READ FROM THE LAST WORD ABOUT THE TASK. A durable queue
   * keeps the older row beside the newer one and hands them back in no promised order, so
   * «the first row with this id» can be the attempt BEFORE the one standing for approval. On a
   * second return in a row that mints a number the task has already used — two rows claiming to
   * be the same attempt, and the card then has to guess which of them the worker is running.
   */
  it('a second return in a row numbers the new attempt from the newest row, not the first in the list', async () => {
    const enqueued: any[] = []
    const front = returnFront(
      [
        { id: 'R-5', attempt: 2, status: 'returned', title: 'собери отчёт', source: 'return', enqueuedAt: 1000 },
        { id: 'R-5', attempt: 3, status: 'awaiting_approval', title: 'собери отчёт', source: 'return', enqueuedAt: 5000 },
      ],
      enqueued,
    )
    const res = await postReturn(front, { taskId: 'R-5', note: 'ещё раз' })
    expect(res.statusCode).toBe(200)
    expect(enqueued[0].attempt, 'attempt 3 is taken — the new row must be 4').toBe(4)
    expect(JSON.parse(res.body).attempt).toBe(4)
  })
})

/**
 * THE WIRE, ASSERTED ON THE DOOR'S OWN ANSWER. The rule that folds a task's rows to its last
 * word lives in the queue and is applied inside the read model — but a computation nobody hands
 * to the caller is not a fix. So this case drives the REAL derive through GET /api/state and
 * reads the body the screen would read: one waiting line for one returned task, and a counter
 * that agrees with it.
 */
describe('server.mjs — GET /api/state counts a returned task ONCE', () => {
  it('two rows of one task, both standing for approval → one line in the body, kpi 1', async () => {
    const rows = [
      { id: 'R-9', status: 'awaiting_approval', lane: 'prod', title: 'собери отчёт', enqueuedAt: 5000, completedAt: 6000 },
      { id: 'R-9', status: 'awaiting_approval', lane: 'prod', title: 'собери отчёт', source: 'return', enqueuedAt: 9000, completedAt: 9500 },
    ]
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { deriveState, adapter: { list: async () => rows.slice() }, clock: () => 20000 },
    })
    const res = await call(front, { url: '/api/state', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.body)
    expect(payload.awaiting).toHaveLength(1)
    expect(payload.awaiting[0]).toMatchObject({ id: 'R-9', title: 'собери отчёт' })
    expect(payload.kpis.awaitingApproval).toBe(1)
  })
})

// ── the five harness handlers (filled a slot, added no route) ──

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

/**
 * The live proof, 05.08.2026: the founder pressed «Включить команду» in the
 * window and «ничего не произошло». No effect, no visible error. The same door with the same
 * body worked from the terminal in both directions, so the failure was on this side.
 *
 * The cause is here and it is one line long. The process holds ONE config object; the applier
 * wrote the roster to disk and returned a NEW config, and nothing put the roster back into the
 * object `GET /api/harness` reads. So the next read served the pre-toggle roster: the cards
 * came back with exactly the `enabled` they had before the click, and the request HAD
 * succeeded, so there was nothing to render as a failure either. The registry doors already
 * obeyed this rule; the three harness appliers did not.
 *
 * The case is written as the window experiences it — toggle, then read — because that pair is
 * the defect. Either half alone looks perfectly healthy.
 */
describe('server.mjs — a toggle is visible to the very next read', () => {
  /** The stock-team applier's real posture: a NEW config, the caller's object untouched. */
  const applyStockTeamToggle = ({ config, enabled }: any) => ({
    ...config,
    workers: config.workers.map((w: any) => ({ ...w, enabled: !!enabled })),
  })
  const applyAgentToggle = ({ config, id, enabled }: any) => ({
    ...config,
    workers: config.workers.map((w: any) => (w.id === id ? { ...w, enabled: !!enabled } : w)),
  })
  /** The read model, as thin as the real one is over `config.workers`. */
  const readHarness = async ({ config }: any) => ({
    agents: config.workers.map((w: any) => ({ id: w.id, enabled: w.enabled !== false })),
    skills: [],
    mcp: [],
    drafts: [],
    stockTeam: config.workers.map((w: any) => ({ id: w.id, enabled: w.enabled !== false, origin: 'sma' })),
  })

  it('«Включить команду» changes what GET /api/harness answers, with no restart', async () => {
    const config = { token: TOKEN, workers: [{ id: 'sma-planner', enabled: false }, { id: 'sma-executor', enabled: false }] }
    const front = createFrontServer({ config, deps: { applyStockTeamToggle, applyAgentToggle, readHarness, loadMcpRegistry: () => ({ servers: [] }) } })

    const before = await call(front, { url: '/api/harness', headers: bearer() })
    expect(JSON.parse(before.body).stockTeam.every((m: any) => m.enabled === false)).toBe(true)

    const flip = await call(front, { method: 'POST', url: '/api/agent/toggle', headers: jsonHeaders(), body: { id: '__stock-team__', enabled: true } })
    expect(flip.statusCode).toBe(200)

    const after = await call(front, { url: '/api/harness', headers: bearer() })
    expect(JSON.parse(after.body).stockTeam.every((m: any) => m.enabled === true)).toBe(true)
  })

  it('the switch of ONE worker is visible to the very next read too', async () => {
    const config = { token: TOKEN, workers: [{ id: 'max-2', enabled: true }, { id: 'max-3', enabled: true }] }
    const front = createFrontServer({ config, deps: { applyAgentToggle, readHarness, loadMcpRegistry: () => ({ servers: [] }) } })

    const flip = await call(front, { method: 'POST', url: '/api/agent/toggle', headers: jsonHeaders(), body: { id: 'max-2', enabled: false } })
    expect(flip.statusCode).toBe(200)

    const after = JSON.parse((await call(front, { url: '/api/harness', headers: bearer() })).body)
    expect(after.agents.find((a: any) => a.id === 'max-2').enabled).toBe(false)
    expect(after.agents.find((a: any) => a.id === 'max-3').enabled).toBe(true)
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

// ── the sixteen: declared ONCE, filled by their own plans, none left ──
//
// The group of 501 cases that stood here is gone: the freeze declared sixteen routes in one
// revision, and every one of them now answers for real (static and projects, machines and
// chat, import and onboarding, each filled in turn). The table never changed —
// a fill plan replaces a stub, it does not add a route. What guards that promise from here
// on is the ZERO STUBS case in the table describe above, plus the 501 that remains for an
// honest reason: a collaborator this daemon was not wired with (the case below).

describe('server.mjs — a 501 now means «not wired here», never «not written yet»', () => {
  it('every remaining 501 is a capability answer: with the deps wired, the route answers', async () => {
    const bare = createFrontServer({ config: { token: TOKEN } })
    // no deriveState wired → the read model is genuinely absent on THIS daemon
    expect((await call(bare, { url: '/api/state', headers: bearer() })).statusCode).toBe(501)

    const wired = createFrontServer({
      config: { token: TOKEN },
      deps: { deriveState: async () => ({ queue: [], done: [] }) },
    })
    expect((await call(wired, { url: '/api/state', headers: bearer() })).statusCode).toBe(200)
  })
})

// ── the `machine` field: another machine is an ADDRESSEE, never another door ──

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

  it('a well-formed machine id with NO federation wired → 501 — never a silent local run', async () => {
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

// ── the machine field goes LIVE ──
//
// The hub RE-ISSUES the founder's action against the machine that owns the task and relays
// that machine's answer verbatim. It re-implements nothing: the peer's own DoR gate, its own
// CAS and its own merge run where the work actually lives. Three properties are proved here
// because all three are load-bearing: the `machine` field is STRIPPED before the request is
// forwarded (a peer must never re-proxy), the peer's status and body arrive unmodified, and
// the local path — machine absent — is untouched.

/** A federation stand-in that records what it was asked to proxy and answers to order. */
function fakeFederation(answer: any = { status: 200, body: { ok: true, from: 'peer' } }) {
  const calls: any[] = []
  return {
    calls,
    proxyAction: async (o: any) => {
      calls.push(o)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

function namedError(name: string) {
  const e = new Error(`${name} for the test`)
  e.name = name
  return e
}

describe('server.mjs — the machine field is LIVE: the hub proxies, it never re-plays', () => {
  const localAdapter = () => {
    const enqueued: any[] = []
    return { enqueued, list: async () => [], enqueue: async (t: any) => (enqueued.push(t), { id: t.id }) }
  }

  it('an addressed enqueue goes to the peer with `machine` STRIPPED — a peer must not re-proxy', async () => {
    const adapter = localAdapter()
    const federation = fakeFederation()
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, federation, clock: () => 1 } })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: jsonHeaders(),
      body: { title: 'сделай отчёт', lane: 'prod', machine: 'mac-mini' },
    })
    expect(res.statusCode).toBe(200)
    expect(federation.calls).toHaveLength(1)
    expect(federation.calls[0]).toMatchObject({ machineId: 'mac-mini', path: '/api/enqueue' })
    expect(federation.calls[0].body).toEqual({ title: 'сделай отчёт', lane: 'prod' })
    expect(federation.calls[0].body.machine).toBeUndefined()
    expect(adapter.enqueued).toHaveLength(0) // the hub did NOT also run it locally
  })

  it("the peer's answer is relayed VERBATIM — status and body, for all three actions", async () => {
    const cases: any[] = [
      ['/api/enqueue', { title: 'x', lane: 'prod' }, { status: 200, body: { ok: true, id: 'R-9', coalesced: false } }],
      ['/api/approve', { taskId: 'R-5' }, { status: 409, body: 'approve race lost (already handled)' }],
      ['/api/return', { taskId: 'R-5', note: 'переделай' }, { status: 200, body: { ok: true, taskId: 'R-5', attempt: 3 } }],
    ]
    for (const [url, body, answer] of cases) {
      const federation = fakeFederation(answer)
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: { adapter: localAdapter(), federation, casExec: makeCasExec('awaiting_approval'), verbRunner: async () => ({ merged: true }), clock: () => 1 },
      })
      const res = await call(front, {
        method: 'POST',
        url,
        headers: jsonHeaders(),
        body: { ...body, machine: 'mac-mini' },
      })
      expect(res.statusCode, url).toBe(answer.status)
      const expected = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
      expect(res.body, url).toBe(expected)
    }
  })

  it('an unknown machine → 404; an unreachable one → 502 (an honest gateway failure)', async () => {
    const cases: Array<[string, number]> = [
      ['UnknownPeerError', 404],
      ['PeerUnreachableError', 502],
      ['ProxyPathNotAllowedError', 400],
    ]
    for (const [name, status] of cases) {
      const federation = fakeFederation(namedError(name))
      const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter: localAdapter(), federation, clock: () => 1 } })
      const res = await call(front, {
        method: 'POST',
        url: '/api/enqueue',
        headers: jsonHeaders(),
        body: { title: 'x', lane: 'prod', machine: 'ghost' },
      })
      expect(res.statusCode, name).toBe(status)
    }
  })

  it("a peer's failure message never rides out — the founder sees a status, not the peer's words", async () => {
    const federation = fakeFederation(namedError('PeerUnreachableError'))
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter: localAdapter(), federation, clock: () => 1 } })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: jsonHeaders(),
      body: { title: 'x', lane: 'prod', machine: 'ghost' },
    })
    expect(res.body).not.toContain('for the test')
  })

  it('REGRESSION: with no machine field the local path runs exactly as before — the federation is never touched', async () => {
    const adapter = localAdapter()
    const federation = fakeFederation()
    const mergeCalls: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter,
        federation,
        casExec: makeCasExec('awaiting_approval'),
        verbRunner: async (o: any) => (mergeCalls.push(o), { merged: true, testsPassed: true }),
        clock: () => 1234,
      },
    })
    const queued = await call(front, { method: 'POST', url: '/api/enqueue', headers: jsonHeaders(), body: { title: 'дома', lane: 'prod' } })
    expect(queued.statusCode).toBe(200)
    expect(JSON.parse(queued.body).id).toBe('R-1234')
    expect(adapter.enqueued[0]).toMatchObject({ id: 'R-1234', source: 'roster', title: 'дома' })

    const approved = await call(front, { method: 'POST', url: '/api/approve', headers: jsonHeaders(), body: { taskId: 'R-77' } })
    expect(approved.statusCode).toBe(200)
    expect(mergeCalls[0].branch).toBe('wt/R-77') // the merge verb ran HERE, locally
    expect(federation.calls).toHaveLength(0) // and nothing was proxied anywhere
  })
})

// ── the daemon serves the built SPA itself ──
//
// «The app rides with the daemon»: the SAME process, behind the SAME token, with NO second
// web server. The file system is an injected seam (deps.fsImpl + deps.staticDir), so these
// cases never touch the real tree — except the ONE smoke at the bottom, which reads the
// real build when a build is present and skips itself when it is not.

/** A file system that SHOUTS if it is ever reached — the traversal proof. */
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

  it('TRAVERSAL dies at the name parse: the file system is never reached', async () => {
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

// ── the project doors + the decision journal on the task card ──
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
      body: { path: '/Users/f/projects/acme-clinic' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).project.name).toBe('acme-clinic')
  })

  it('POST /api/project/rename moves the NAME and never the id', async () => {
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

/**
 * A pinned repoDir was deleted from the file by one press in the window (05.08.2026).
 *
 * The live incident, in order: the founder's `~/.sma-daemon/config.json` carried a `repoDir`
 * pin (the daemon is launched from a temp worktree, so the pin is the only thing that says
 * which tree the roster and the interview belong to). One press, and the pin was gone from
 * the file. The daemon then derived `repoDir` = its launch directory, and GET /api/onboarding
 * flipped to `needed: true`, because a worktree carries no `.sma/profile.json`.
 *
 * The mechanism is a seam, not a typo. `stripDerivedDirs` drops a key only when the file's
 * value equals what the derive WOULD produce — and the derive's `repoDir` is whatever
 * baseline the caller hands in. The composition root hands the doors the EFFECTIVE repoDir
 * (`o.repoDir ?? config.repoDir`), which for a pinned config IS the pin, so the comparison
 * read «pin === pin» and the pin was deleted as if nobody had ever typed it.
 *
 * These two cases are written the way PRODUCTION wires it — the real door, `deps.repoDir`
 * set to the effective repoDir, exactly what main.mjs passes — because that wiring is the
 * defect. The unit cases that came with all pass a fake LAUNCH directory as
 * the baseline, which is the semantically correct one, and that is why they stayed green
 * through the whole incident.
 */
describe('server.mjs — a pinned repoDir survives a write through the window', () => {
  const PIN = '/Users/f/projects/sma' // the tree the founder pinned by hand
  const CONFIG_ROOT = dirname(PROJECT_ENV.SMA_DAEMON_CONFIG)

  /** The ONE object the composition root serves: the file's pin IS the effective repoDir. */
  const pinnedConfig = () => ({
    token: TOKEN,
    workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/m2' }, enabled: true }],
    projects: [],
    activeProject: null,
    repoDir: PIN,
    dataDir: join(CONFIG_ROOT, 'data'), // derive-equal: these two MUST still be stripped
    ledgerDir: join(CONFIG_ROOT, 'ledger'),
  })

  it('POST /api/project/add keeps the pin and still strips the two derive-equal dirs', async () => {
    const fsImpl = capturingConfigFs()
    const config: any = pinnedConfig()
    const front = createFrontServer({
      config,
      // the production wiring: deps.repoDir is main.mjs's `o.repoDir ?? config.repoDir`
      deps: { addProject, renameProject, selectProject, env: PROJECT_ENV, fsImpl, repoDir: config.repoDir },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/project/add',
      headers: jsonHeaders(),
      body: { path: '/Users/f/projects/mass-platform', name: 'Платформа' },
    })
    expect(res.statusCode).toBe(200)

    const stored = fsImpl.written[fsImpl.written.length - 1]
    expect(stored.projects).toHaveLength(1) // the write itself happened
    expect(stored.repoDir, "the operator's pin was deleted by a project add").toBe(PIN)
    expect(stored.dataDir).toBeUndefined()
    expect(stored.ledgerDir).toBeUndefined()
  })

  it('POST /api/agent/toggle keeps the pin too — the appliers write through the same seam', async () => {
    const fsImpl = capturingConfigFs()
    const config: any = pinnedConfig()
    const front = createFrontServer({
      config,
      deps: { applyAgentToggle, env: PROJECT_ENV, fsImpl, repoDir: config.repoDir },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/agent/toggle',
      headers: jsonHeaders(),
      body: { id: 'max-2', enabled: false },
    })
    expect(res.statusCode).toBe(200)

    const stored = fsImpl.written[fsImpl.written.length - 1]
    expect(stored.workers[0].enabled).toBe(false)
    expect(stored.repoDir, "the operator's pin was deleted by an agent toggle").toBe(PIN)
    expect(stored.dataDir).toBeUndefined()
    expect(stored.ledgerDir).toBeUndefined()
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

  it('the sessionId on a ledger row does NOT travel to the card — the read model is an explicit pick', async () => {
    const withSession = {
      readAttempts: () => [
        { attempt: 1, workerId: 'max-1', outcome: 'completed', sessionId: '9f8e7d6c-1234-4abc-8def-0123456789ab' },
      ],
    }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, ledger: withSession } })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    // The audit row keeps it — it is the one fact about a finished attempt nothing can
    // recover afterwards. The screen has no use for it, so the payload never names it, and
    // that is asserted on the BYTES rather than on the shape.
    expect(res.body).not.toContain('9f8e7d6c-1234-4abc-8def-0123456789ab')
    expect(Object.hasOwn(JSON.parse(res.body).attempts[0], 'sessionId')).toBe(false)
  })

  it('a task older than the journal → EMPTY layers, never an error', async () => {
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, ledger: { readAttempts: () => [] } } })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.journal).toEqual({ dispatcher: [], memoryTrace: { notes: [], reflexes: [] } })
  })
})

/**
 * THE CARD ANSWERS WITH THE LAST WORD ABOUT THE TASK — the same rule the queue and the waiting
 * list already answer by.
 *
 * Measured on a live run: a piece of a batch failed its gate, its owner pressed «Повторить», the
 * repeat came back green and the piece stood for approval — and its card said «не получилось»
 * and offered no «Одобрить» at all, because the window derives that button from the status this
 * door sends. `/api/state` said `awaiting_approval` in the very same second. The door was
 * picking «the first row with this id», and with a durable queue the first row of a repeated
 * piece is the one it broke on. The owner could not accept finished work from his own window.
 *
 * The fake adapter answers rows in the shapes the real queue returns (id/title/lane/status/
 * attempt/source/enqueuedAt) and is no richer than it.
 */
describe('server.mjs — GET /api/task/:id answers with the LAST word about the task', () => {
  const cardFront = (rows: any[]) =>
    createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: { list: async () => rows.slice() }, ledger: { readAttempts: () => [] } },
    })

  it('a failed first attempt beside a repeat that stands for approval → the card reads awaiting_approval', async () => {
    const front = cardFront([
      { id: 'B-7-1', title: 'почини сборку', lane: 'prod', status: 'failed', attempt: 1, enqueuedAt: 1000 },
      { id: 'B-7-1', title: 'почини сборку', lane: 'prod', status: 'awaiting_approval', attempt: 2, source: 'return', enqueuedAt: 5000 },
    ])
    const res = await call(front, { url: '/api/task/B-7-1', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    // this pair of fields is what the window turns into the «Одобрить» button
    expect(out.task.status).toBe('awaiting_approval')
    expect(out.task.attempt).toBe(2)
  })

  it('a returned row beside the newer attempt → the card reads the newer one, never `returned`', async () => {
    const front = cardFront([
      { id: 'R-5', title: 'собери отчёт', lane: 'prod', status: 'returned', attempt: 2, enqueuedAt: 1000 },
      { id: 'R-5', title: 'собери отчёт', lane: 'prod', status: 'queued', attempt: 3, source: 'return', enqueuedAt: 5000 },
    ])
    const res = await call(front, { url: '/api/task/R-5', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.task.status).toBe('queued')
    expect(out.task.attempt).toBe(3)
  })

  it('a task of ONE row answers exactly as before, and an unknown id is still 404', async () => {
    const front = cardFront([
      { id: 'R-9', title: 'ночная задача', lane: 'prod', status: 'completed', attempt: 2, enqueuedAt: 1000 },
    ])
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).task).toMatchObject({ id: 'R-9', title: 'ночная задача', lane: 'prod', status: 'completed', attempt: 2 })
    expect((await call(front, { url: '/api/task/R-404', headers: bearer() })).statusCode).toBe(404)
  })

  it('the running attempt is synthesised from the LAST row too — a claimed repeat shows as running', async () => {
    const front = cardFront([
      { id: 'B-7-1', title: 'почини сборку', lane: 'prod', status: 'failed', attempt: 1, enqueuedAt: 1000 },
      { id: 'B-7-1', title: 'почини сборку', lane: 'prod', status: 'claimed', attempt: 2, workerId: 'max-1', claimedAt: '2026-08-15T10:00:00.000Z', enqueuedAt: 5000 },
    ])
    const res = await call(front, { url: '/api/task/B-7-1', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.task.status).toBe('claimed')
    expect(out.attempts).toHaveLength(1)
    expect(out.attempts[0]).toMatchObject({ attempt: 2, workerId: 'max-1', outcome: 'running' })
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
