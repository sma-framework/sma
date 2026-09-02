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

import { describe, it, expect, afterAll } from 'vitest'
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
  CANCEL_ATTEMPT_CLOSE_WAIT_MS,
  CANCEL_ATTEMPT_POLL_MS,
} from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'
import { taskChangeRange } from '../src/front/task-changes.mjs'
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

describe('server.mjs — the closed SIXTY-FOUR-route table', () => {
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
  // RE-FREEZE REVISION (20.08.2026): + POST /api/task/cancel — a person stops a task with a
  // finger. The queue could already close a row terminally, but only a command line could ask
  // it to; and closing the row is only half — the live child under the task has to die FIRST,
  // or the stopping leaves an orphan process working for nobody.
  // RE-FREEZE REVISION (25.08.2026): + GET /api/phase/:id/files — the folder of ONE phase,
  // read from the window: its directory as a tree, and one file of it as text. The artefact
  // door opens only the documents the card knows how to name; everything else a phase left in
  // its own directory existed for a terminal and for nothing else. Read-only, and the path is
  // locked three times over (text, resolved, real), so no spelling of it leaves that directory.
  // RE-FREEZE REVISION (28.08.2026): + POST /api/skill/create — a person WRITES a skill in the
  // window and it becomes a file in this machine's skill store, ready to be given to a worker.
  // No existing door could do this: /api/forge asks a worker to draft one and waits for an
  // approval, which is the right road for «придумай мне навык» and the wrong one for «вот
  // текст, положи его», and /api/skill/assign refuses a skill whose file does not exist yet —
  // so «создать навык из окна» had no path at all. It writes into the MACHINE store only, and
  // it refuses an id that is already taken rather than overwriting somebody's skill.
  // RE-FREEZE REVISION (31.08.2026): + POST /api/project/planning — the SECOND ADDRESS of a
  // project: the folder that holds its `.planning`. Until it existed, a house that keeps code
  // and planning in two repositories had to be registered as TWO projects — tasks visible in
  // one, phases and backlog in the other, and neither switchable off without losing what it
  // held. It moves no code tree: the product stays where it stands, and only where planning is
  // read from changes.
  // The sixty-seventh and sixty-eighth BREAK THE TRANSCRIPT INTO CONVERSATIONS: one lists
  // them (freshest first, with a live mark on the one a turn is running in), the other lets a
  // person NAME one by hand. Until they existed the window opened a NEW conversation almost
  // every time it was opened — fifty replies had scattered across fifteen threads — showed
  // every thread of a project as one unbroken feed, and offered no way back into an earlier one.
  it('the frozen table has EXACTLY sixty-eight routes', () => {
    expect(Object.keys(ROUTES)).toHaveLength(68)
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
   * ═══ КРАСНЫЙ ПРОГОН, КОТОРЫЙ ОЗНАЧАЕТ «СЛИЯНИЯ НЕ БЫЛО» ════════════════════════
   *
   * Ритуал слияния теперь решает ДО того, как записать: красный прогон отменяет сведение и
   * возвращает `{merged:false, testsPassed:false}`. Случай выше остаётся рядом нетронутым —
   * дверь обязана понимать ОБЕ формы, — а этот проверяет новую: одобрения не происходит,
   * строка остаётся ждать, и обе формы приезжают человеку с одним и тем же смыслом.
   */
  it('отказ ритуала «слияния не было, тесты красные» тоже не одобряется', async () => {
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        casExec: makeCasExec('awaiting_approval'),
        verbRunner: async (o: any) => ({
          merged: false,
          testsPassed: false,
          refused: true,
          branch: o.branch,
          receipt: { branch: o.branch, testsPassed: false, refused: true },
        }),
        repoDir: '/repo',
      },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: { ...bearer(), 'content-type': 'application/json' },
      body: { taskId: 'R-79b' },
    })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.merged).toBe(false)
    expect(out.ok).toBe(false)
  })

  /**
   * ═══════ РЕЕСТР УЗНАЁТ О ЗАКРЫТИИ КАРТОЧКИ, И УЗНАЁТ ЗДЕСЬ ═══════════════════════
   *
   * Решение человека не записывалось никуда, кроме смертной строки очереди: минуту приёмки окно
   * выводило из следа УБОРКИ (`cleanup.by === 'approve'`) — из следствия, которого может не быть
   * вовсе, — а pg-boss уносит законченную работу в архив по сроку хранения. После этого «эту
   * карточку закрывали?» оставался вопросом без ответа, и обход беклога честно ставил принятую и
   * слитую работу в очередь заново (парный случай — в loop.test.ts).
   *
   * Строка закрытия — ОТДЕЛЬНАЯ, того же подхода, и БЕЗ `outcome`/`endedAt`: свёртка подходов не
   * имеет права ни растянуть длительность попытки до минуты решения, ни переписать то, чем
   * попытка кончилась. Ровно тот же закон, что у `cleanup` и `memoryHarvest`.
   */
  describe('приёмка пишет закрытие карточки в реестр попыток', () => {
    function ledgerSpy(rows: any[] = []) {
      const written: any[] = []
      return {
        written,
        seam: {
          readAttempts: () => rows,
          recordAttempt: (row: any) => {
            written.push(row)
            return row
          },
        },
      }
    }

    it('зелёная приёмка кладёт строку `closed` с минутой, дверью и отпечатком слияния', async () => {
      const spy = ledgerSpy([{ taskId: 'R-81', attempt: 2, outcome: 'completed', branch: 'wt/R-81' }])
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({
            merged: true,
            testsPassed: true,
            branch: o.branch,
            receipt: { branch: o.branch, testsPassed: true, resultSha: 'a'.repeat(40) },
          }),
          repoDir: '/repo',
          ledger: spy.seam,
          clock: () => Date.parse('2026-08-31T11:12:00.000Z'),
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
      const closing = spy.written.filter((r) => r.closed)
      expect(closing, 'реестр не узнал о закрытии карточки').toHaveLength(1)
      expect(closing[0].taskId).toBe('R-81')
      expect(closing[0].attempt, 'номер подхода взят не из реестра').toBe(2)
      expect(closing[0].closed).toEqual({
        at: '2026-08-31T11:12:00.000Z',
        by: 'approve',
        merged: true,
        mergeSha: 'a'.repeat(40),
      })
      // строка РЕШЕНИЯ, а не строка попытки: ни исхода, ни конца попытки на ней нет
      expect(Object.hasOwn(closing[0], 'outcome')).toBe(false)
      expect(Object.hasOwn(closing[0], 'endedAt')).toBe(false)
    })

    it('красная приёмка не пишет закрытия: работа осталась ждать решения', async () => {
      const spy = ledgerSpy([{ taskId: 'R-82', attempt: 1, outcome: 'completed', branch: 'wt/R-82' }])
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: false, branch: o.branch }),
          repoDir: '/repo',
          ledger: spy.seam,
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-82' },
      })

      expect(JSON.parse(res.body).ok).toBe(false)
      expect(spy.written.filter((r) => r.closed)).toEqual([])
    })

    /**
     * ДОКУМЕНТАРНАЯ СТУПЕНЬ, КОТОРОЙ НЕЧЕГО БЫЛО СЛИВАТЬ, ТОЖЕ ЗАКРЫТА ЧЕЛОВЕКОМ — и строка
     * обязана различать «принято» и «слито»: закрытие есть, `merged:false`.
     */
    it('приёмка без слияния закрывает карточку и говорит вслух, что слияния не было', async () => {
      const spy = ledgerSpy([{ taskId: 'R-83', attempt: 1, outcome: 'completed' }]) // ни одна попытка не назвала ветки
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async () => {
            throw new Error('слияния быть не должно')
          },
          repoDir: '/repo',
          ledger: spy.seam,
          clock: () => Date.parse('2026-08-31T11:12:00.000Z'),
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-83' },
      })

      expect(JSON.parse(res.body).ok).toBe(true)
      const [closing] = spy.written.filter((r) => r.closed)
      expect(closing.closed).toEqual({ at: '2026-08-31T11:12:00.000Z', by: 'approve', merged: false })
    })

    it('реестр, который не пишется, не превращает принятую работу в отказ', async () => {
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
          ledger: {
            readAttempts: () => [{ taskId: 'R-84', attempt: 1, outcome: 'completed', branch: 'wt/R-84' }],
            recordAttempt: () => {
              throw new Error('ledger is read-only')
            },
          },
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-84' },
      })

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).merged).toBe(true)
    })
  })

  /**
   * ═══════ A REFUSAL OF THIS DOOR SAYS WHY, IN WORDS, OR IT IS NOT A REFUSAL ═══════
   *
   * Пресс на «Одобрить» отвечал `ok:false` и НИ ОДНОГО слова. Человек у окна не мог отличить
   * конфликт от исчезнувшей ветки, красных тестов и гонки двух терминалов — а это четыре
   * разных действия в ответ. Живая приёмка так и записала: «нажалась и ничего не сделала».
   *
   * Ритуал слияния УЖЕ различает эти случаи (мягкий отказ с держателем слота, красный прогон,
   * сообщение git) — их просто никто не доводил до тела ответа. Поэтому тест стоит на ТЕЛЕ
   * ДВЕРИ: провод доказывается тем, что по нему доехало.
   */
  describe('a refusal names its cause in words the person at the window reads', () => {
    async function refuse(taskId: string, merge: any) {
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => (typeof merge === 'function' ? merge(o) : merge),
          repoDir: '/repo',
        },
      })
      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId },
      })
      expect(res.statusCode).toBe(200)
      return JSON.parse(res.body)
    }

    it('красный прогон на слитом результате назван тестами, а не пустым отказом', async () => {
      const out = await refuse('R-90', (o: any) => ({ merged: true, testsPassed: false, branch: o.branch }))
      expect(out.ok).toBe(false)
      expect(out.reasonCode).toBe('tests_red')
      expect(out.reason).toMatch(/тест/i)
    })

    /**
     * Та же причина, ДРУГАЯ форма ответа. Ритуал решает до записи, поэтому честный отказ
     * приезжает как `{merged:false, testsPassed:false}`. Прошлый предикат требовал признака
     * состоявшегося слияния и на этой форме не срабатывал — отказ проваливался мимо него в
     * общую ветку и приезжал человеку безымянным. Оба случая стоят рядом, потому что дверь
     * обязана понимать обе формы, а не менять одну на другую.
     */
    it('отказ «слияния не было, тесты красные» тоже назван тестами', async () => {
      const out = await refuse('R-90b', (o: any) => ({ merged: false, testsPassed: false, refused: true, branch: o.branch }))
      expect(out.ok).toBe(false)
      expect(out.reasonCode).toBe('tests_red')
      expect(out.reason).toMatch(/тест/i)
      // и слово описывает то, что произошло на самом деле: ветка НЕ слита.
      expect(out.reason).toMatch(/не выполнено/i)
    })

    /**
     * КАКОЙ ТЕСТ И ПОЧЕМУ — В САМОМ ОТКАЗЕ. Замерено 31.08.2026: отказ приехал словами
     * «тесты на сведённом дереве красные» и ничем больше, и приёмщик пошёл искать причину
     * руками — час чужого времени и возвращённая работнику здоровая работа. Ритуал теперь
     * называет упавший тест и первые строки причины; дверь обязана ДОВЕСТИ это до глаз, а
     * не оставить в квитанции, которую на карточке никто не разворачивает.
     */
    it('красный отказ несёт имя упавшего теста и первые строки причины', async () => {
      const out = await refuse('R-90d', () => ({
        merged: false,
        refused: true,
        testsPassed: false,
        failedTest: 'scripts/sma/__tests__/merge-gate.test.ts > гейт слияния > Test 5',
        failureDetail: 'AssertionError: expected false to be true\n  at merge-gate.test.ts:260:24',
      }))
      expect(out.reasonCode).toBe('tests_red')
      expect(out.reason).toContain('merge-gate.test.ts')
      expect(out.reason).toContain('Test 5')
      expect(out.reason).toContain('AssertionError')
    })

    /**
     * …И ГДЕ ЭТО ЧИТАТЬ. Отказ отсылал к выводу прогона, а вывода не было НИГДЕ: отчёт
     * полного набора писался во временный каталог и умирал вместе с отказом (02.09.2026,
     * первая ночная приёмка). Полный прогон при живых соседних сессиях умеет краснеть ложно,
     * и отличить такой красный от настоящего можно только по отчёту — значит, путь к нему
     * обязан стоять в самом отказе, рядом с именами.
     */
    it('красный отказ называет ВСЕ упавшие тесты и путь к сохранённому отчёту', async () => {
      const out = await refuse('R-90f', () => ({
        merged: false,
        refused: true,
        testsPassed: false,
        failedTest: 'scripts/sma/__tests__/landing.test.ts > посадка > Test 5',
        failedTests: [
          'scripts/sma/__tests__/landing.test.ts > посадка > Test 5',
          'daemon/__tests__/broken-import.test.ts',
        ],
        savedReport: '/var/sma/data/landing/R-90f-2026-09-02T18-58-00-000Z.json',
      }))
      expect(out.reasonCode).toBe('tests_red')
      expect(out.reason).toContain('landing.test.ts')
      expect(out.reason, 'второй упавший тест потерялся по дороге к глазам').toContain('broken-import.test.ts')
      expect(out.reason, 'путь к отчёту не доехал — читать отказ по-прежнему негде').toContain(
        '/var/sma/data/landing/R-90f-2026-09-02T18-58-00-000Z.json',
      )
    })

    it('красный отказ без сохранённого отчёта говорит, что отчёта нет, а не молчит', async () => {
      const out = await refuse('R-90g', () => ({ merged: false, refused: true, testsPassed: false }))
      expect(out.reasonCode).toBe('tests_red')
      expect(out.reason).toMatch(/отчёта прогона не сохранилось/i)
    })

    it('красный отказ без имени теста честно говорит, что имени не назвали', async () => {
      const out = await refuse('R-90e', () => ({ merged: false, refused: true, testsPassed: false }))
      expect(out.reasonCode).toBe('tests_red')
      expect(out.reason, 'выдуманное имя отправит человека чинить не тот тест').toMatch(/имя.*не назв/i)
    })

    /**
     * СРЕДА, А НЕ ТЕСТЫ. Гейт слияния смотрит на пригодность дерева ДО прогона; когда
     * склада зависимостей нет, прогона не было вовсе и `testsPassed` остаётся null.
     * 31.08.2026 склад опустошался трижды за сутки, и каждый раз человек читал «тесты
     * красные» — то есть шёл искать регрессию в ветке работника, пока чинить надо было
     * среду. Отказ стоит ВЫШЕ красного прогона, потому что это разные починки.
     */
    it('сломанная среда названа средой, а не красными тестами', async () => {
      const out = await refuse('R-90c', (o: any) => ({
        merged: false,
        refused: true,
        envBroken: true,
        testsPassed: null,
        reason: 'среда сломана: daemon — каталог зависимостей daemon/node_modules ПУСТ',
        branch: o.branch,
      }))
      expect(out.ok).toBe(false)
      expect(out.reasonCode).toBe('env_broken')
      expect(out.reason).toMatch(/среда сломана/i)
      expect(out.reason).not.toMatch(/тесты красные/i)
    })

    /**
     * ОКНО, А НЕ ТЕСТЫ. Посадка пересобирает раздачу окна на сведённом дереве ДО прогона —
     * иначе гейт свежести раздачи краснеет на каждой ветке, тронувшей исходник окна. Сборка,
     * которая не прошла, останавливает слияние ДО первого теста; 02.09.2026 такой отказ
     * приезжал как «тесты красные, имя теста не названо», и человек шёл искать упавший тест,
     * которого не существовало.
     */
    it('несобравшееся окно названо сборкой, а не красными тестами', async () => {
      const out = await refuse('R-90f', () => ({
        merged: false,
        refused: true,
        spaBuildFailed: true,
        testsPassed: null,
        failureDetail: 'src/main.tsx(12,3): error TS1005: ")" expected.\nvite build failed',
      }))
      expect(out.ok).toBe(false)
      expect(out.reasonCode).toBe('spa_build_failed')
      expect(out.reason).toMatch(/окно не собралось/i)
      expect(out.reason, 'хвост сборки — единственное место, где живёт причина').toContain('TS1005')
      expect(out.reason).not.toMatch(/тесты.*красн/i)
    })

    it('конфликт слияния назван конфликтом', async () => {
      const out = await refuse('R-91', {
        ok: false,
        message: 'CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed; fix conflicts',
      })
      expect(out.ok).toBe(false)
      expect(out.reasonCode).toBe('conflict')
      expect(out.reason).toMatch(/конфликт/i)
    })

    it('исчезнувшая ветка названа веткой, а не «слияние не прошло»', async () => {
      const out = await refuse('R-92', {
        ok: false,
        message: "merge: wt/R-92 - not something we can merge",
      })
      expect(out.ok).toBe(false)
      expect(out.reasonCode).toBe('branch_missing')
      expect(out.reason).toMatch(/ветк/i)
    })

    it('несохранённые правки в дереве названы деревом — их убирает человек, а не кнопка', async () => {
      const out = await refuse('R-93', {
        ok: false,
        message: 'error: Your local changes to the following files would be overwritten by merge:',
      })
      expect(out.ok).toBe(false)
      expect(out.reasonCode).toBe('tree_dirty')
      expect(out.reason).toMatch(/правк|дерев/i)
    })

    it('гонка двух терминалов доносит до окна СВОЮ фразу, ту самую, что назвала держателя', async () => {
      const override = 'слияние уже идёт (T-2) — дождитесь завершения'
      const out = await refuse('R-94', { merged: false, softDenied: true, override, holder: { by: 'T-2' } })
      expect(out.ok).toBe(false)
      expect(out.reasonCode).toBe('merge_busy')
      expect(out.reason).toBe(override) // не пересказ — та самая фраза, с держателем внутри
      expect(out.softDenied).toBe(true)
    })

    it('незнакомый отказ git всё равно несёт слова: класс не угадан — сказано, что сказал git', async () => {
      const out = await refuse('R-95', { ok: false, message: 'fatal: something nobody classified' })
      expect(out.ok).toBe(false)
      expect(out.reasonCode).toBe('merge_failed')
      expect(out.reason).toContain('something nobody classified')
    })

    it('ЗАКОН: ни один ok:false этой двери не уходит без слова', async () => {
      const shapes = [
        { merged: true, testsPassed: false },
        { ok: false, message: 'CONFLICT (content): Merge conflict in x' },
        { ok: false, message: 'fatal: ветка не найдена' },
        { merged: false, softDenied: true, override: 'слияние уже идёт' },
        {}, // ритуал вернул нечто вовсе неопознанное — и это тоже отказ, а не молчание
        null,
      ]
      let n = 0
      for (const shape of shapes) {
        n += 1
        const out = await refuse(`R-96${n}`, shape)
        expect(out.ok).toBe(false)
        expect(typeof out.reason).toBe('string')
        expect(out.reason.length).toBeGreaterThan(0)
        expect(out.reasonCode.length).toBeGreaterThan(0)
      }
    })

    it('успех НИЧЕГО не объясняет: у зелёного слияния причины отказа нет вовсе', async () => {
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
        },
      })
      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-97' },
      })
      const out = JSON.parse(res.body)
      expect(out.ok).toBe(true)
      expect(out.reason).toBeUndefined()
      expect(out.reasonCode).toBeUndefined()
    })
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

  /**
   * ═══════ ПРИНЯТАЯ РАБОТА УБИРАЕТ ЗА СОБОЙ КОПИЮ — И ГОВОРИТ, ЧТО УБРАЛА ═══════
   *
   * Слияние проходило, ветка входила в main — и копия задачи со своей веткой оставалась на
   * диске навсегда: так у основателя накопились копии закрытых задач недельного возраста.
   * Уборка приходит в дверь ОТДЕЛЬНОЙ зависимостью, а не через общий раннер вербов: дверь,
   * которой дали раннер, умеющий назвать любую команду, — это дверь, через которую можно
   * назвать любую команду. У `worktreeCleanup({taskId, by})` называть нечего.
   *
   * И порядок обязанностей: приёмка — правда, уборка — следствие. Неудача уборки не
   * отменяет `merged:true`, но обязана доехать до ответа: человек должен УЗНАТЬ, что на
   * диске осталось, а не догадаться по отсутствию строки.
   */
  describe('после слияния дверь убирает копию задачи — отдельной зависимостью', () => {
    const cleanupSpy = (answer: any) => {
      const calls: any[] = []
      const worktreeCleanup = async (a: any) => {
        calls.push(a)
        if (typeof answer === 'function') return answer(a)
        return answer
      }
      return { worktreeCleanup, calls }
    }

    it('merged:true → уборка вызвана РОВНО раз, с задачей и поводом; ответ несёт cleanup', async () => {
      const { worktreeCleanup, calls } = cleanupSpy({
        ok: true,
        removed: true,
        removedPath: '/projects/.sma-worktrees/R-77',
        removedBranch: 'wt/R-77',
        branchTip: 'abc1234',
      })
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
          worktreeCleanup,
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-77' },
      })

      expect(res.statusCode).toBe(200)
      // …И КАТАЛОГ, В КОТОРОМ КОПИЯ ЛЕЖИТ — тот же, в котором дверь только что искала ветку.
      // Без него уборка спрашивала бы про копию задачи одного проекта у другого и честно не
      // находила бы её. Реестра здесь нет, поэтому это обслуживаемое дерево, как и раньше.
      expect(calls).toEqual([{ taskId: 'R-77', by: 'approve', cwd: '/repo' }])
      const out = JSON.parse(res.body)
      expect(out.merged).toBe(true)
      expect(out.cleanup).toEqual({
        removed: true,
        removedPath: '/projects/.sma-worktrees/R-77',
        removedBranch: 'wt/R-77',
      })
    })

    it('слияние не прошло — копия НЕ убирается: работу ещё могут доделать в ней', async () => {
      const { worktreeCleanup, calls } = cleanupSpy({ ok: true, removed: true })
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async () => ({ merged: false, message: 'конфликт' }),
          repoDir: '/repo',
          worktreeCleanup,
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
      expect(out.merged).toBe(false)
      expect(calls).toEqual([]) // ни одного вызова уборки
      expect(Object.hasOwn(out, 'cleanup')).toBe(false)
    })

    it('уборка сорвалась — приёмка ВСЁ РАВНО правда, а причина видна в ответе', async () => {
      const { worktreeCleanup } = cleanupSpy(() => {
        throw new Error('верб недоступен')
      })
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
          worktreeCleanup,
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
      expect(out.merged).toBe(true)
      expect(out.ok).toBe(true)
      expect(out.cleanup.removed).toBe(false)
      expect(out.cleanup.reason).toContain('верб недоступен')
    })

    /**
     * ═══ СНАЧАЛА ПАМЯТЬ, ПОТОМ УБОРКА — И ЭТО УТВЕРЖДАЕТСЯ ПОРЯДКОМ, А НЕ НАМЕРЕНИЕМ ═══
     *
     * Урок работника лежит черновиком В КОПИИ. На проекте, где каталог правил вне git (так
     * живёт этот продукт), слияние ветки его не приносит, а принудительное удаление копии
     * сносит каталог вместе с ним. Значит между слиянием и уборкой обязан стоять сбор памяти,
     * и «обязан стоять» здесь — не комментарий: две зависимости, вызванные в неверном порядке,
     * стирают урок молча и ровно один раз на задачу. Поэтому кейс смотрит на
     * ПОСЛЕДОВАТЕЛЬНОСТЬ вызовов, а не на то, что обе позваны.
     */
    const orderSpies = (harvestAnswer: any, cleanupAnswer: any = { ok: true, removed: true }) => {
      const order: string[] = []
      const memoryHarvest = async (a: any) => {
        order.push('memoryHarvest')
        if (typeof harvestAnswer === 'function') return harvestAnswer(a)
        return harvestAnswer
      }
      const worktreeCleanup = async () => {
        order.push('worktreeCleanup')
        return cleanupAnswer
      }
      return { memoryHarvest, worktreeCleanup, order }
    }

    it('merged:true → память собирается ПЕРЕД уборкой, и ответ несёт что доехало в корпус', async () => {
      const { memoryHarvest, worktreeCleanup, order } = orderSpies({
        ok: true,
        mode: 'untracked',
        copied: ['drafts/lesson-r-81-alpha.md'],
        applied: ['lesson-r-81-alpha'],
        drafted: ['approach-r-81-1'],
        refused: [],
        skipCleanup: false,
      })
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
          memoryHarvest,
          worktreeCleanup,
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-81' },
      })

      expect(res.statusCode).toBe(200)
      expect(order).toEqual(['memoryHarvest', 'worktreeCleanup'])
      const out = JSON.parse(res.body)
      expect(out.memoryHarvest).toEqual({
        ok: true,
        mode: 'untracked',
        copied: ['drafts/lesson-r-81-alpha.md'],
        applied: ['lesson-r-81-alpha'],
        drafted: ['approach-r-81-1'],
        refused: [],
      })
      expect(out.cleanup.removed).toBe(true)
    })

    it('сбор провалился на игнорируемом корпусе — копия НЕ убирается, и причина названа', async () => {
      const { memoryHarvest, worktreeCleanup, order } = orderSpies({
        ok: false,
        mode: 'untracked',
        copied: [],
        applied: [],
        drafted: [],
        refused: [{ id: 'lesson-r-82-alpha', reason: 'конвейер отказал' }],
        skipCleanup: true,
        reason: 'конвейер отказал',
      })
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
          memoryHarvest,
          worktreeCleanup,
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-82' },
      })

      expect(res.statusCode).toBe(200)
      expect(order).toEqual(['memoryHarvest']) // уборки не было вовсе
      const out = JSON.parse(res.body)
      expect(out.ok).toBe(true) // приёмка — правда; сбор её не отменяет
      expect(out.cleanup.removed).toBe(false)
      expect(out.cleanup.reason).toContain('конвейер отказал')
      expect(out.memoryHarvest.ok).toBe(false)
      expect(out.memoryHarvest.refused[0].id).toBe('lesson-r-82-alpha')
    })

    it('конвейер отказал, но черновик уже в дереве — уборка ИДЁТ, отказ виден в ответе', async () => {
      // Отказ приёмки — сообщение человеку, а не причина держать копию: урок к этому моменту
      // лежит вторым экземпляром в основном дереве. Сбор говорит это одним полем, и дверь
      // обязана читать именно его, а не выводить решение из `ok`.
      const { memoryHarvest, worktreeCleanup, order } = orderSpies({
        ok: false,
        mode: 'untracked',
        copied: ['drafts/lesson-r-83-alpha.md'],
        applied: [],
        drafted: [],
        refused: [{ id: 'lesson-r-83-alpha', reason: 'запись не проходит проверку схемы' }],
        skipCleanup: false,
        reason: 'запись не проходит проверку схемы',
      })
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
          memoryHarvest,
          worktreeCleanup,
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-83' },
      })

      expect(res.statusCode).toBe(200)
      expect(order).toEqual(['memoryHarvest', 'worktreeCleanup'])
      const out = JSON.parse(res.body)
      expect(out.cleanup.removed).toBe(true)
      expect(out.memoryHarvest.ok).toBe(false)
      expect(out.memoryHarvest.refused[0].id).toBe('lesson-r-83-alpha')
    })

    it('сбор бросил — приёмка стоит, копия сохранена, исключение доехало причиной', async () => {
      const { memoryHarvest, worktreeCleanup, order } = orderSpies(() => {
        throw new Error('корпус недоступен')
      })
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
          memoryHarvest,
          worktreeCleanup,
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-83' },
      })

      expect(res.statusCode).toBe(200)
      expect(order).toEqual(['memoryHarvest'])
      const out = JSON.parse(res.body)
      expect(out.ok).toBe(true)
      expect(out.memoryHarvest.ok).toBe(false)
      expect(out.memoryHarvest.reason).toContain('корпус недоступен')
      expect(out.cleanup.reason).toContain('корпус недоступен')
    })

    it('слияние не прошло — не собирают и не убирают: работу ещё могут доделать в копии', async () => {
      const { memoryHarvest, worktreeCleanup, order } = orderSpies({ ok: true, skipCleanup: false })
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async () => ({ merged: false, message: 'конфликт' }),
          repoDir: '/repo',
          memoryHarvest,
          worktreeCleanup,
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-84' },
      })

      expect(res.statusCode).toBe(200)
      expect(order).toEqual([])
      const out = JSON.parse(res.body)
      expect(Object.hasOwn(out, 'memoryHarvest')).toBe(false)
      expect(Object.hasOwn(out, 'cleanup')).toBe(false)
    })

    it('демон без сбора памяти убирает как прежде — поля memoryHarvest в ответе нет', async () => {
      const { worktreeCleanup, calls } = cleanupSpy({ ok: true, removed: true })
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
          worktreeCleanup,
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-85' },
      })

      expect(res.statusCode).toBe(200)
      expect(calls).toHaveLength(1)
      expect(Object.hasOwn(JSON.parse(res.body), 'memoryHarvest')).toBe(false)
    })

    it('демон без уборки отвечает ровно как прежде — без поля cleanup', async () => {
      const front = createFrontServer({
        config: { token: TOKEN },
        deps: {
          casExec: makeCasExec('awaiting_approval'),
          verbRunner: async (o: any) => ({ merged: true, testsPassed: true, branch: o.branch }),
          repoDir: '/repo',
        },
      })

      const res = await call(front, {
        method: 'POST',
        url: '/api/approve',
        headers: { ...bearer(), 'content-type': 'application/json' },
        body: { taskId: 'R-80' },
      })

      expect(res.statusCode).toBe(200)
      expect(Object.hasOwn(JSON.parse(res.body), 'cleanup')).toBe(false)
    })
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
    expect(out.journal.memoryTrace).toMatchObject({ notes: ['reference_sma_dev_workspace'], reflexes: ['no-new-store'] })
  })

  /**
   * ═══ СЛОЙ ПАМЯТИ ПОПЫТКИ ДОЕЗЖАЕТ ДО КАРТОЧКИ ЦЕЛИКОМ ═══
   *
   * Слой перестал быть заявлением конфига и стал наблюдением: что сессия открыла в корпусе,
   * сколько раз позвала конвейер, что сработало под её личностью, чему она научила и оставила
   * ли записку. Всё это уже писалось в журнал — и не отдавалось никому: читалка брала из слоя
   * ровно два списка. Вычислено и записано — не то же самое, что предъявлено.
   *
   * Берётся ПОСЛЕДНЯЯ строка слоя: списки заметок складываются по всем попыткам (их читали
   * все), а «чему научила» и «оставила ли записку» принадлежат последней — иначе провал
   * первой попытки навсегда закрыл бы урок второй.
   */
  it('карточка видит весь слой памяти: что прочитано, откуда рефлексы, чему научила попытка', async () => {
    const ledger = {
      readAttempts: () => [{ attempt: 1, workerId: 'max-1', outcome: 'failed' }, { attempt: 2, workerId: 'max-2', outcome: 'completed' }],
      readJournalEntries: () => [
        {
          taskId: 'R-9',
          attempt: 1,
          layer: 'memory',
          payload: { notes: ['alpha'], reflexes: [], loaded: { index: true, reads: ['alpha'], loadCalls: 1 }, lesson: { missing: true }, approach: 'absent' },
          recordedAt: '2026-08-01T02:00:00.000Z',
        },
        {
          taskId: 'R-9',
          attempt: 2,
          layer: 'memory',
          payload: {
            notes: ['beta'],
            reflexes: ['no-new-store'],
            reflexSource: 'sma-journal',
            loaded: { index: true, reads: ['beta'], loadCalls: 2 },
            autoMemoryReads: ['memory-check-grey-morning'],
            lesson: { written: 'drafts/lesson-r-9-alpha.md' },
            approach: 'journaled',
          },
          recordedAt: '2026-08-01T03:00:00.000Z',
        },
      ],
    }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, ledger } })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const trace = JSON.parse(res.body).journal.memoryTrace
    // списки — по всем попыткам, без повторов
    expect(trace.notes).toEqual(['alpha', 'beta'])
    expect(trace.reflexes).toEqual(['no-new-store'])
    // …а «чем кончилась память задачи» — по ПОСЛЕДНЕЙ строке слоя
    expect(trace.loaded).toEqual({ index: true, reads: ['beta'], loadCalls: 2 })
    expect(trace.autoMemoryReads).toEqual(['memory-check-grey-morning'])
    expect(trace.reflexSource).toBe('sma-journal')
    expect(trace.lesson).toEqual({ written: 'drafts/lesson-r-9-alpha.md' })
    expect(trace.approach).toBe('journaled')
  })

  it('the sessionId travels ONLY when it can be resumed — the read model is still an explicit pick', async () => {
    // ПРЕЖНЕЕ УТВЕРЖДЕНИЕ ЭТОГО СЛУЧАЯ БЫЛО ОБРАТНЫМ: идентификатор сессии не уезжал к
    // карточке вовсе, потому что «экрану он ни к чему». Это оказалось верно про экран и
    // неверно про человека: продолжение попытки давно поднимает ТУ ЖЕ сессию, а войти в неё
    // самому — посмотреть, спросить, продолжить — было нельзя, и разница между «демон знает»
    // и «человек может» стоила разбора после каждой сорванной попытки. Теперь дверь называет
    // его явным выбором, и явность выбора сторожится ровно как раньше: наружу едет ТОЛЬКО
    // пригодное к продолжению, а всё прочее по-прежнему остаётся на строке аудита.
    const resumable = '9f8e7d6c-1234-4abc-8def-0123456789ab'
    const withSession = {
      readAttempts: () => [{ attempt: 1, workerId: 'max-1', outcome: 'completed', sessionId: resumable }],
    }
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, ledger: withSession } })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).attempts[0].sessionId).toBe(resumable)

    // …а ручка не той формы не едет никуда: командная строка её отвергнет, и предложить по
    // ней возврат значило бы дать человеку строку, которая выглядит рабочей. Утверждается на
    // БАЙТАХ, а не на форме — ключ есть всегда, и молчать он обязан значением.
    const junk = { readAttempts: () => [{ attempt: 1, workerId: 'max-1', outcome: 'failed', sessionId: 'сессия-которой-нет' }] }
    const second = createFrontServer({ config: { token: TOKEN }, deps: { adapter, ledger: junk } })
    const other = await call(second, { url: '/api/task/R-9', headers: bearer() })
    expect(other.body).not.toContain('сессия-которой-нет')
    expect(JSON.parse(other.body).attempts[0].sessionId).toBe(null)
  })

  it('a task older than the journal → EMPTY layers, never an error', async () => {
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, ledger: { readAttempts: () => [] } } })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.journal).toEqual({
      dispatcher: [],
      // Слой поправок — тем же пустым списком: задача, в ход которой никто не вмешивался, и
      // задача старше слоя читаются одинаково, и обе — списком, а не отсутствием ключа.
      redirects: [],
      // Каждое поле НАЗВАНО нулём, а не опущено: карточка читает одну форму для любой задачи,
      // и «этого ключа здесь нет» — то, с чего поверхность начинает гадать.
      memoryTrace: { notes: [], reflexes: [], loaded: null, autoMemoryReads: null, reflexSource: null, lesson: null, approach: null },
    })
  })
})

/**
 * ═══ ВСЁ, ЧЕГО ЧЕЛОВЕКУ НЕ ХВАТАЛО ДЛЯ ОТКАТА, ДОЕЗЖАЕТ ДО ОТВЕТА ДВЕРИ ═══════════
 *
 * Три вещи существуют и лежат в трёх разных местах, ни одно из которых не смотрит на карточку:
 * список изменённого и исчезнувшего (в строке попытки), признак противоречия свёрнутой записи
 * и отпечаток коммита слияния (вычислен, доезжает до колонки, читателя нет ни одного).
 *
 * Дверь называет их ЯВНО, тем же перечислением, каким названы шесть полей копии: строка леджера
 * не имеет права протащить в тело ответа ключ, который дверь не назвала. Отпечаток слияния
 * проходит проверку формы ПЕРЕД тем, как попасть в команду, которую человек скопирует и
 * выполнит: не прошёл — поля нет вовсе, и карточка о нём молчит.
 */
describe('server.mjs — GET /api/task/:id несёт то, чем откатывают', () => {
  const rowsOf = (extra: any = {}) => [{ id: 'R-9', title: 'ночная задача', lane: 'prod', status: 'completed', attempt: 1, ...extra }]

  const cardFront = (attempts: any[], extra: any = {}) =>
    createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: { list: async () => rowsOf(extra) }, ledger: { readAttempts: () => attempts } },
    })

  it('список изменённого, ОТДЕЛЬНЫЙ список исчезнувшего и оба счётчика перебора едут на карточку', async () => {
    const front = cardFront([
      {
        attempt: 1,
        outcome: 'completed',
        base: 'a1b2c3d',
        branch: 'wt/R-9',
        files: [
          { status: 'M', path: 'src/a.ts' },
          { status: 'D', path: 'src/gone.ts' },
          { status: 'R100', path: 'новое имя.txt', from: 'старое имя.txt' },
        ],
        deletions: ['src/gone.ts', 'старое имя.txt'],
        filesOverflow: 4,
        deletionsOverflow: 1,
      },
    ])
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const a = JSON.parse(res.body).attempts[0]
    expect(a.files).toHaveLength(3)
    expect(a.files[2]).toEqual({ status: 'R100', path: 'новое имя.txt', from: 'старое имя.txt' })
    // ЦЕНА ОШИБКИ НЕСИММЕТРИЧНА: исчезнувшее — отдельный ключ, а не статус внутри списка.
    expect(a.deletions).toEqual(['src/gone.ts', 'старое имя.txt'])
    expect(a.filesOverflow).toBe(4)
    expect(a.deletionsOverflow).toBe(1)
  })

  it('попытка старше этих полей МОЛЧИТ: нули, а не выдуманные пустые списки', async () => {
    const front = cardFront([{ attempt: 1, outcome: 'completed' }])
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    const a = JSON.parse(res.body).attempts[0]
    expect(a.files).toBe(null)
    expect(a.deletions).toBe(null)
    expect(a.filesOverflow).toBe(null)
    expect(a.deletionsOverflow).toBe(null)
    expect(a.conflict).toBe(null)
  })

  it('«не перепроверено» доезжает до карточки: объектная ссылка становится доказательством', async () => {
    const front = cardFront([
      {
        attempt: 1,
        outcome: 'completed',
        receiptRef: { unverified: true, reason: 'preexisting_red_only', branch: 'wt/R-9', base: 'a1b2c3d', commits: 2, preexistingRed: 3, newRed: 0 },
      },
    ])
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    const a = JSON.parse(res.body).attempts[0]
    expect(a.proof).toMatchObject({ kind: 'gate', unverified: true, reason: 'preexisting_red_only', preexistingRed: 3, newRed: 0, commits: 2 })
  })

  it('аномалия предъявляется как аномалия: свёрнутая запись несёт ОБА исхода', async () => {
    const front = cardFront([
      { attempt: 1, outcome: 'failed', failureReason: 'tests_red' },
      { attempt: 1, outcome: 'completed', receiptRef: 'reverify:abc1234' },
    ])
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    const out = JSON.parse(res.body)
    expect(out.attempts).toHaveLength(1)
    expect(out.attempts[0].conflict).toEqual({ outcomes: ['failed', 'completed'], rows: 2 })
  })

  it('отпечаток коммита слияния и путь репозитория доезжают до задачи — из них человек собирает команду', async () => {
    const full = '0123456789abcdef0123456789abcdef01234567'
    const front = cardFront([{ attempt: 1, outcome: 'completed' }], {
      status: 'approved',
      mergeReceipt: JSON.stringify({ branch: 'wt/R-9', resultSha: full, repo: '/projects/demo', testsPassed: true }),
    })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    const task = JSON.parse(res.body).task
    expect(task.mergeSha).toBe(full)
    expect(task.mergeRepo).toBe('/projects/demo')
  })

  it('СТАРАЯ квитанция с семью знаками читается — переписывать её нельзя и не нужно', async () => {
    const front = cardFront([{ attempt: 1, outcome: 'completed' }], {
      status: 'approved',
      mergeReceipt: JSON.stringify({ branch: 'wt/R-9', resultSha: 'abc1234', testsPassed: true }),
    })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    const task = JSON.parse(res.body).task
    expect(task.mergeSha).toBe('abc1234')
    expect(task.mergeRepo).toBe(null)
  })

  it('отпечаток НЕ прошёл проверку формы → поля нет вовсе, и карточка о нём молчит', async () => {
    const bads = ['--upload-pack=rm -rf /', 'HEAD; rm -rf /', 'zzzz', '0123456789abcdef0123456789abcdef012345678', '']
    for (const bad of bads) {
      const front = cardFront([{ attempt: 1, outcome: 'completed' }], {
        status: 'approved',
        mergeReceipt: JSON.stringify({ branch: 'wt/R-9', resultSha: bad, repo: '/projects/demo' }),
      })
      const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
      const task = JSON.parse(res.body).task
      expect(task.mergeSha, 'отпечаток проехал в команду человека: ' + bad).toBe(null)
    }
  })

  it('битая квитанция слияния не роняет дверь — карточка просто молчит о слиянии', async () => {
    const front = cardFront([{ attempt: 1, outcome: 'completed' }], { status: 'approved', mergeReceipt: '{не json' })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).task.mergeSha).toBe(null)
  })

  it('путь репозитория, который мог бы оказаться вторым аргументом, не отдаётся вовсе', async () => {
    const front = cardFront([{ attempt: 1, outcome: 'completed' }], {
      status: 'approved',
      mergeReceipt: JSON.stringify({ resultSha: 'abc1234', repo: '--exec=rm -rf /' }),
    })
    const res = await call(front, { url: '/api/task/R-9', headers: bearer() })
    expect(JSON.parse(res.body).task.mergeRepo).toBe(null)
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

/**
 * THE MACHINE'S OWN NAME IS NOT ANOTHER MACHINE.
 *
 * The reading the window works from stamps every local task with this daemon's own machine id
 * — «self» when none is configured — and the card hands that value straight back with the
 * decision, exactly as it was told to. The door then read any non-empty `machine` as «somebody
 * else's machine», found no federation wired into this daemon, and answered 501. The result,
 * measured on a live run: «Одобрить» could not work on ANY task of ANY daemon without
 * federation, and a founder's task had been waiting on that button for four days.
 *
 * The fix is one comparison against the SAME source `/api/machines` publishes as its own id.
 * Two locks on one defect: the card stops sending its own id (so an older daemon accepts the
 * press too), and the door treats its own id as local (so a newer card is not required).
 * A genuinely foreign id without federation still answers 501 — that refusal is untouched.
 */
describe('server.mjs — the daemon own machine id means LOCAL, not «proxy it away»', () => {
  const approveFront = (config: any, mergeCalls: any[]) =>
    createFrontServer({
      config,
      deps: {
        casExec: makeCasExec('awaiting_approval'),
        verbRunner: async (o: any) => (mergeCalls.push(o), { merged: true, testsPassed: true, branch: o.branch }),
        repoDir: '/repo',
      },
    })

  it('approve addressed to «self» runs LOCALLY — no federation needed, no 501', async () => {
    const mergeCalls: any[] = []
    const front = approveFront({ token: TOKEN }, mergeCalls)
    const res = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: jsonHeaders(),
      body: { taskId: 'R-77', machine: 'self' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).merged).toBe(true)
    expect(mergeCalls[0].branch).toBe('wt/R-77') // the merge really ran here
  })

  it('approve with a FOREIGN machine and no federation still answers 501 and merges nothing', async () => {
    const mergeCalls: any[] = []
    const front = approveFront({ token: TOKEN }, mergeCalls)
    const res = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: jsonHeaders(),
      body: { taskId: 'R-77', machine: 'other' },
    })
    expect(res.statusCode).toBe(501)
    expect(mergeCalls).toHaveLength(0)
  })

  it('a CONFIGURED machine id addressing itself is local too — the same source /api/machines publishes', async () => {
    const mergeCalls: any[] = []
    const front = approveFront({ token: TOKEN, machineId: 'alpha' }, mergeCalls)
    const res = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: jsonHeaders(),
      body: { taskId: 'R-79', machine: 'alpha' },
    })
    expect(res.statusCode).toBe(200)
    expect(mergeCalls[0].branch).toBe('wt/R-79')

    // and the machines door agrees about who «alpha» is
    const machines = await call(front, { url: '/api/machines', headers: bearer() })
    expect(machines.statusCode).toBe(200)
    expect(JSON.parse(machines.body).machines?.[0]?.id).toBe('alpha')
  })

  it('enqueue addressed to «self» is put in the local queue instead of refused', async () => {
    const enqueued: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: { enqueue: async (t: any) => (enqueued.push(t), { id: t.id, coalesced: false }) }, clock: () => 1234 },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: jsonHeaders(),
      body: { title: 'сделай отчёт', lane: 'prod', machine: 'self' },
    })
    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({ id: 'R-1234', source: 'roster', title: 'сделай отчёт' })
  })

  it('return addressed to «self» returns the work locally — CAS plus the re-queue', async () => {
    const enqueued: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: {
          list: async () => [{ id: 'R-5', attempt: 2, status: 'awaiting_approval' }],
          enqueue: async (t: any) => (enqueued.push(t), { id: t.id }),
        },
        casExec: makeCasExec('awaiting_approval'),
      },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/return',
      headers: jsonHeaders(),
      body: { taskId: 'R-5', note: 'переделай вывод', machine: 'self' },
    })
    expect(res.statusCode).toBe(200)
    expect(enqueued[0]).toMatchObject({ id: 'R-5', source: 'return', attempt: 3 })
  })
})

/**
 * A DIFF THAT IS GONE IS NOT AN ERROR — IT IS A SENTENCE.
 *
 * After the work is accepted, the copy and its branch are removed on purpose; the commits
 * themselves stay in the project's tree. Git then fails on the branch name, and this door used to
 * answer 404 — which the card asks for on EVERY open, so a finished task showed a red
 * transport error for work that had been merged correctly. The removal record already keeps
 * the branch tip, and the attempt row keeps the base it was cut from: two commits are enough
 * to show exactly what the worker changed, long after the branch is gone.
 *
 * Both values become arguments of git, so both are checked as hex object names before they
 * are used; anything else degrades to words, never to a command. And when there is nothing
 * left to show at all, the answer is still 200 — with a sentence a person can read.
 */
describe('server.mjs — GET /api/diff/:id after the copy is removed: kept commits or words, never 404', () => {
  const fakeGit = (behaviour: (argv: string[]) => string) => {
    const calls: string[][] = []
    const execGit = (argv: string[]) => {
      calls.push(argv)
      return behaviour(argv)
    }
    return { execGit, calls }
  }

  it('with the branch still there the diff is the WHOLE branch — from where it left the trunk, not its last commit', async () => {
    const git = fakeGit(() => 'diff --git a/x.ts b/x.ts\n+one\n')
    const front = createFrontServer({ config: { token: TOKEN }, deps: { execGit: git.execGit, repoDir: '/repo' } })
    const res = await call(front, { url: '/api/diff/R-1', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('diff --git a/x.ts')
    // `git show <branch>` used to stand here, and it shows ONE commit — so a task with three
    // of them was read through the changes of its last one, while the roster panel counted
    // the whole branch. One range, asked through the seam both surfaces share.
    expect(git.calls[0]).toEqual(['diff', '--stat', '-p', taskChangeRange('R-1')])
  })

  it('the branch is gone but the removal kept its tip: the diff of base..tip, under a note', async () => {
    const base = 'a'.repeat(40)
    const tip = 'b'.repeat(40)
    const git = fakeGit((argv) => {
      if (argv.includes(taskChangeRange('R-2'))) throw new Error('unknown revision')
      return 'diff --git a/y.ts b/y.ts\n+two\n'
    })
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        execGit: git.execGit,
        repoDir: '/repo',
        ledger: () => [
          { taskId: 'R-2', attempt: 1, base, branch: 'wt/R-2' },
          { taskId: 'R-2', attempt: 1, cleanup: { at: '2026-08-18T22:37:54.276Z', by: 'approve', branchTip: tip, ok: true } },
        ],
      },
    })
    const res = await call(front, { url: '/api/diff/R-2', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(res.body.startsWith('# копия убрана')).toBe(true)
    expect(res.body).toContain('diff --git a/y.ts')
    // the wire is proven by what travelled along it
    expect(git.calls[1]).toEqual(['diff', '--stat', '-p', base + '..' + tip])
  })

  it('a branch tip that is not a commit name never reaches git — it answers in words', async () => {
    const git = fakeGit((argv) => {
      if (argv.includes(taskChangeRange('R-3'))) throw new Error('unknown revision')
      return 'should never be reached'
    })
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        execGit: git.execGit,
        repoDir: '/repo',
        ledger: () => [{ taskId: 'R-3', attempt: 1, base: 'c'.repeat(40), cleanup: { branchTip: '; rm -rf /' } }],
      },
    })
    const res = await call(front, { url: '/api/diff/R-3', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('# диф недоступен: копия убрана')
    expect(git.calls).toHaveLength(1) // only the branch read that failed
  })

  it('nothing left in the ledger either: still 200, still a sentence, never a 404', async () => {
    const git = fakeGit(() => {
      throw new Error('unknown revision')
    })
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { execGit: git.execGit, repoDir: '/repo', ledger: () => [] },
    })
    const res = await call(front, { url: '/api/diff/R-4', headers: bearer() })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('# диф недоступен: копия убрана')
  })
})

// ── УПРЁТСЯ ЛИ ОДОБРЕНИЕ В СТЕНУ: провод от билета до ответа двери карточки ──
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runsDirOf, attemptRunDir } from '../src/queue/run-dir.mjs'
import { attemptIdFor } from '../src/front/journal.mjs'

/**
 * ЧЕЛОВЕК УЗНАЁТ О СТЕНЕ ДО ТОГО, КАК В НЕЁ УПРЁТСЯ.
 *
 * Живой прогон прошлой фазы показал ловушку: карточка предлагает одобрить вызов, который
 * физически не сможет выполниться — жёсткий запрет уехал в аргументы запуска, работник до
 * него не дотягивается, и одобрение просто превращается в отказ.
 *
 * Это тест ПРОВОДА, а не вычисления: он кладёт настоящий билет и настоящий `run.json` в
 * настоящий каталог попытки, спрашивает НАСТОЯЩУЮ дверь карточки и утверждает, что ответ
 * доехал до её ответа. Сшивка живёт именно здесь — это единственное место, где есть и билет
 * (его пишет хук внутри копии), и каталог попытки (его знает демон).
 */
describe('server.mjs — GET /api/task/:id говорит, упрётся ли одобрение в жёсткий запрет', () => {
  const tmps: string[] = []
  const mkProject = () => {
    const d = mkdtempSync(join(tmpdir(), 'sma-wall-'))
    tmps.push(d)
    return d
  }
  afterAll(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true })
  })

  const seed = (projectDir: string, { cls, args }: { cls: string; args?: string[] | null }) => {
    const runDir = attemptRunDir({ runsDir: runsDirOf(projectDir), attemptId: attemptIdFor('R-9', 1) }) as string
    mkdirSync(join(runDir, 'tickets'), { recursive: true })
    writeFileSync(
      join(runDir, 'tickets', 'tk-wall.json'),
      JSON.stringify({
        schema: 'sma-ticket/1',
        id: 'tk-wall',
        attemptId: 'R-9_1',
        status: 'waiting',
        tool: 'Bash',
        command: 'git ' + 'push' + ' origin main',
        class: cls,
        reason: 'отправка в удалённый репозиторий — действие человека',
        seenAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    )
    if (args) writeFileSync(join(runDir, 'run.json'), JSON.stringify({ schema: 'sma-run/1', taskId: 'R-9', attempt: 1, args }))
    return runDir
  }

  const front = (projectDir: string, lane: string | null = 'prod') =>
    createFrontServer({
      config: { token: TOKEN, repoDir: projectDir },
      deps: {
        adapter: { list: async () => [{ id: 'R-9', title: 'ночная задача', lane, status: 'claimed', attempt: 1 }] },
        ledger: { readAttempts: () => [] },
        phaseCycleDir: () => projectDir,
      },
    })

  const ALL_PUSH = ['Bash(git ' + 'push' + ':*)', 'Bash(git remote:*)', 'Bash(git config:*)']
  // каждый шаблон отдельным значением — так их кладёт сборщик аргументов, и так их читает стена
  const argsDenying = (patterns: string[]) => ['--model', 'opus', '--disallowedTools', ...patterns]

  it('билет упирающегося класса: дверь называет стену и действие, рядом с самим билетом', async () => {
    const dir = mkProject()
    seed(dir, { cls: 'push', args: argsDenying(ALL_PUSH) })
    const res = await call(front(dir), { url: '/api/task/R-9', headers: bearer() })
    expect(res.statusCode).toBe(200)
    const a = JSON.parse(res.body).attempts[0]
    expect(a.ticket?.id).toBe('tk-wall')
    expect(a.approvalWall).toEqual({ state: 'blocked', action: 'push', source: 'spawn-args' })
  })

  it('билет класса, чьё действие этой попытке НЕ запрещали, — стены нет, и это сказано', async () => {
    const dir = mkProject()
    seed(dir, { cls: 'tag', args: argsDenying(ALL_PUSH) })
    const a = JSON.parse((await call(front(dir), { url: '/api/task/R-9', headers: bearer() })).body).attempts[0]
    expect(a.approvalWall).toEqual({ state: 'clear', action: 'tag', source: 'spawn-args' })
  })

  it('класса нет в карте → поля нет: экран молчит, а не успокаивает', async () => {
    const dir = mkProject()
    seed(dir, { cls: 'reset-hard', args: argsDenying(ALL_PUSH) })
    const a = JSON.parse((await call(front(dir), { url: '/api/task/R-9', headers: bearer() })).body).attempts[0]
    expect(a.ticket?.id).toBe('tk-wall')
    expect(a.approvalWall).toBe(null)
  })

  it('ни аргументов попытки, ни полосы → поля нет вовсе', async () => {
    const dir = mkProject()
    seed(dir, { cls: 'push', args: null })
    const a = JSON.parse((await call(front(dir, null), { url: '/api/task/R-9', headers: bearer() })).body).attempts[0]
    expect(a.approvalWall).toBe(null)
  })

  it('аргументов попытки нет — отвечает конверт полосы, и он назван источником', async () => {
    const dir = mkProject()
    seed(dir, { cls: 'merge', args: null })
    const a = JSON.parse((await call(front(dir, 'prod'), { url: '/api/task/R-9', headers: bearer() })).body).attempts[0]
    expect(a.approvalWall).toEqual({ state: 'blocked', action: 'merge', source: 'lane-envelope' })
  })

  it('билета нет — вопрос не задаётся вовсе', async () => {
    const dir = mkProject()
    const a = JSON.parse((await call(front(dir), { url: '/api/task/R-9', headers: bearer() })).body).attempts[0]
    expect(a.ticket).toBe(null)
    expect(a.approvalWall).toBe(null)
  })
})

// ── дверь отмены: человек останавливает работу, и остановка не оставляет живого процесса ──
//
// ПОЧЕМУ ЭТИ ДЕЛА ЖИВУТ ЗДЕСЬ. Дверь отмены — запись ЗАКРЫТОЙ таблицы, и её защиты (потолок
// тела, отказ неизвестным ключам, форма идентификатора) — это ровно тот набор, который этот
// файл сторожит у всей поверхности. Отдельный файл дел развёл бы одно обещание по двум местам.
//
// ГЛАВНОЕ ДЕЛО ЗДЕСЬ — О ПОРЯДКЕ, А НЕ О ФАКТЕ ДВУХ ВЫЗОВОВ. Два счётчика докажут только то,
// что и убийство, и закрытие строки состоялись; мина же — в их последовательности. Строка,
// помеченная закрытой раньше, чем умер процесс, оставляет живого ребёнка без хозяина: сторож
// живости видит непонятное, заводит новую попытку, и подписка горит параллельными процессами.
// Поэтому оба вызова пишут в ОДНУ ЛЕНТУ, и утверждается лента целиком.

/** Реестр ручек живых попыток, который ПИШЕТ В ЛЕНТУ — подделка ровно того размера, что нужна. */
function tapedTurns(tape: string[], o: { live: boolean; closes: boolean }) {
  let stopped = false
  return {
    stop(taskId: string) {
      tape.push(`attemptTurns.stop(${taskId})`)
      if (!o.live) return false
      stopped = true
      return true
    },
    /** Пока попытка не закрылась, её запись ещё помечена остановленной; закрытие стирает запись. */
    wasStopped() {
      return stopped && !o.closes
    },
  }
}

/** Очередь, которая пишет в ту же ленту. `terminal` — что отвечает наш метод остановки. */
function tapedAdapter(tape: string[], terminal: boolean) {
  return {
    async cancelTask(taskId: string) {
      tape.push(`cancelTask(${taskId})`)
      return terminal
    },
  }
}

const cancelReq = (body: any) => ({
  method: 'POST',
  url: '/api/task/cancel',
  headers: { ...bearer(), 'content-type': 'application/json' },
  body,
})

describe('POST /api/task/cancel — человек останавливает задачу', () => {
  it('без очереди дверь честно говорит «не собрано», а не притворяется', async () => {
    const front = createFrontServer({ config: { token: TOKEN }, deps: {} })
    expect((await call(front, cancelReq({ taskId: 'R-1' }))).statusCode).toBe(501)
  })

  it('тело разбирается со всеми тремя защитами соседней двери', async () => {
    const tape: string[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: tapedAdapter(tape, true), sleep: async () => {} },
    })
    for (const bad of [{}, { taskId: '../evil' }, { taskId: 'R-1', extra: 1 }, { taskId: 5 }]) {
      const res = await call(front, cancelReq(bad))
      expect(res.statusCode, JSON.stringify(bad)).toBe(400)
    }
    // Ни одна кривая просьба не доехала до очереди.
    expect(tape).toEqual([])
    // И тело сверх потолка — тоже отказ, а не пятисотка.
    const huge = await call(front, cancelReq({ taskId: 'R-1', note: 'x'.repeat(20_000) }))
    expect([400, 413]).toContain(huge.statusCode)
  })

  it('kills the live child BEFORE it closes the row — одна лента вызовов, а не два счётчика', async () => {
    const tape: string[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: tapedAdapter(tape, true),
        attemptTurns: tapedTurns(tape, { live: true, closes: true }),
        sleep: async () => {},
      },
    })
    const res = await call(front, cancelReq({ taskId: 'R-1' }))
    expect(res.statusCode).toBe(200)
    // ЛЕНТА ЦЕЛИКОМ: убийство стоит ПЕРЕД закрытием строки, и между ними нет ничего лишнего.
    expect(tape).toEqual(['attemptTurns.stop(R-1)', 'cancelTask(R-1)'])
    expect(JSON.parse(res.body)).toEqual({ cancelled: true, killed: true, attemptClosed: true })
  })

  it('ручки нет — строку всё равно закрываем, и ответ не утверждает убийства', async () => {
    const tape: string[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: tapedAdapter(tape, true),
        attemptTurns: tapedTurns(tape, { live: false, closes: true }),
        sleep: async () => {},
      },
    })
    const res = await call(front, cancelReq({ taskId: 'R-2' }))
    expect(res.statusCode).toBe(200)
    expect(tape).toEqual(['attemptTurns.stop(R-2)', 'cancelTask(R-2)'])
    const body = JSON.parse(res.body)
    expect(body.cancelled).toBe(true)
    expect(body.killed).toBe(false)
    // «Дождались закрытия попытки» — не «нет», а «нечего было ждать»: разные вещи.
    expect(body.attemptClosed).toBe(null)
  })

  it('демон, собранный вовсе без реестра ручек, дверь всё равно держит', async () => {
    const tape: string[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: tapedAdapter(tape, true), sleep: async () => {} },
    })
    const res = await call(front, cancelReq({ taskId: 'R-3' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ cancelled: true, killed: false, attemptClosed: null })
  })

  it('попытка не закрылась за отведённый срок — строку закрываем, и об этом сказано отдельным полем', async () => {
    const tape: string[] = []
    let naps = 0
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: tapedAdapter(tape, true),
        attemptTurns: tapedTurns(tape, { live: true, closes: false }),
        sleep: async () => {
          naps += 1
        },
      },
    })
    const res = await call(front, cancelReq({ taskId: 'R-4' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ cancelled: true, killed: true, attemptClosed: false })
    // Ожидание ОГРАНИЧЕНО названной константой: дверь не висит на человеке бесконечно.
    expect(naps).toBeGreaterThan(0)
    expect(naps).toBeLessThanOrEqual(CANCEL_ATTEMPT_CLOSE_WAIT_MS / CANCEL_ATTEMPT_POLL_MS)
    // И строка всё равно закрыта — терминал не отменяется тем, что ребёнок умирал долго.
    expect(tape).toEqual(['attemptTurns.stop(R-4)', 'cancelTask(R-4)'])
  })

  it('останавливать было нечего — честное «нет», а не тишина и не выдуманный успех', async () => {
    const tape: string[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: { adapter: tapedAdapter(tape, false), sleep: async () => {} },
    })
    const res = await call(front, cancelReq({ taskId: 'R-5' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).cancelled).toBe(false)
  })
})
