/**
 * Tests for daemon/src/front/diagnostics.mjs and the two «Дом системы» doors of
 * daemon/src/front/server.mjs (GET /api/diagnostics, POST /api/update/run).
 *
 * WHY THE FIRST CASE IS AN EQUALITY AND NOT A CONTAINMENT. The diagnostic block is written
 * into a PUBLIC issue by the person reading it, so the question is never «are the four
 * fields present» — it is «is anything ELSE present». `toEqual` on the key set is the only
 * assertion that answers the second question: a `toContain` sweep passes forever while a
 * later field quietly adds the repository path to every bug report ever filed.
 *
 * The negative half is asserted the same way, on a fixture built to leak: the injected
 * capability file, os and process all carry extra fields, and the answer still has four.
 *
 * The update door is tested for the one property that matters more than its report: an
 * update NEVER starts by itself. The fake runner records the flag it was called with, so
 * «no confirm ⇒ the applying path was not reached» is a recorded fact, not a reading.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { collectDiagnostics, DIAGNOSTIC_KEYS } from '../src/front/diagnostics.mjs'
import { createFrontServer, PENDING_ROUTES, UPDATE_RECEIPT_FORMAT } from '../src/front/server.mjs'

const TOKEN = 'd'.repeat(64)
const bearer = () => ({ authorization: `Bearer ${TOKEN}` })
const jsonHeaders = () => ({ ...bearer(), 'content-type': 'application/json' })

// ── fake req/res (the shape every front suite drives handlers with) ──

function mkReq({ method = 'GET', url = '/', headers = {}, body }: any = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : [])
  req.method = method
  req.url = url
  req.headers = headers
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    ended: false,
    headersSent: false,
    writeHead(code: number, headers: Record<string, string> = {}) {
      res.statusCode = code
      res.headers = { ...res.headers, ...headers }
      res.headersSent = true
      return res
    },
    end(chunk?: any) {
      if (chunk != null) res.body += String(chunk)
      res.ended = true
      return res
    },
  }
  return res
}

async function call(front: any, req: any) {
  const res = mkRes()
  await front.handle(req, res)
  return res
}

// ── the fixture is built to LEAK: everything below is something a report may not carry ──

const SECRET_TOKEN_VALUE = 'sk-ant-oat01-THIS-VALUE-MUST-NEVER-APPEAR'

const LEAKY_CAPABILITY = JSON.stringify({
  id: 'sma',
  version: '5.3.0',
  // every one of these is a field a well-meaning later commit could add, and every one of
  // them is something a public issue may not carry
  installedFrom: 'C:/Users/founder/projects/secret-client-work',
  configPath: 'C:/Users/founder/.sma-daemon/config.json',
  token: SECRET_TOKEN_VALUE,
  projects: ['secret-client-work', 'private-institute-platform'],
})

const leakyFs = { readFileSync: () => LEAKY_CAPABILITY }
const leakyOs = {
  platform: () => 'win32',
  release: () => '10.0.26200',
  // os carries far more than the two facts asked for — hostname is a person's own name
  hostname: () => 'FOUNDER-DESKTOP',
  homedir: () => 'C:/Users/founder',
  userInfo: () => ({ username: 'founder' }),
}
const leakyProcess = {
  version: 'v24.14.1',
  cwd: () => 'C:/Users/founder/projects/secret-client-work',
  env: { SMA_MAX_1_TOKEN: SECRET_TOKEN_VALUE },
}

const collectLeaky = () => collectDiagnostics({ capabilityPath: '/ignored', fsImpl: leakyFs, osImpl: leakyOs, processImpl: leakyProcess })

describe('collectDiagnostics — a whitelist compared for EQUALITY, because the reader is the internet', () => {
  it('returns EXACTLY {version, platform, release, node} — no more, no less', () => {
    const d = collectLeaky()
    // the exact set, both ways: nothing missing (the report would be useless) and nothing
    // extra (the report would be a leak). Sorted so key ORDER is not what is under test.
    expect(Object.keys(d).sort()).toEqual([...DIAGNOSTIC_KEYS].sort())
    expect(Object.keys(d)).toHaveLength(4)
  })

  it('carries the four values it was given, from their four separate sources', () => {
    expect(collectLeaky()).toEqual({ version: '5.3.0', platform: 'win32', release: '10.0.26200', node: 'v24.14.1' })
  })

  it('the whole serialization holds no path, no project name, no host, no token', () => {
    const serialized = JSON.stringify(collectLeaky())
    for (const forbidden of [
      SECRET_TOKEN_VALUE,
      'secret-client-work',
      'private-institute-platform',
      'C:/Users/founder',
      'FOUNDER-DESKTOP',
      'founder',
      'SMA_MAX_1_TOKEN',
      '.sma-daemon',
    ]) {
      expect(serialized, `«${forbidden}» must not survive into a public issue`).not.toContain(forbidden)
    }
  })

  it('an unreadable version stamp is an honest null — never the path it failed on', () => {
    const d = collectDiagnostics({
      capabilityPath: 'C:/Users/founder/.sma-daemon/absent/capability.json',
      fsImpl: {
        readFileSync: () => {
          throw new Error("ENOENT: no such file or directory, open 'C:/Users/founder/.sma-daemon/absent/capability.json'")
        },
      },
      osImpl: leakyOs,
      processImpl: leakyProcess,
    })
    expect(d.version).toBeNull()
    expect(Object.keys(d).sort()).toEqual([...DIAGNOSTIC_KEYS].sort())
    expect(JSON.stringify(d)).not.toContain('.sma-daemon')
  })

  it('a corrupt stamp is the same honest null, not a throw', () => {
    const d = collectDiagnostics({ capabilityPath: '/x', fsImpl: { readFileSync: () => '{ not json' }, osImpl: leakyOs, processImpl: leakyProcess })
    expect(d.version).toBeNull()
  })

  it('a stamp with no usable version field yields null rather than an empty string', () => {
    for (const raw of ['{}', '{"version":""}', '{"version":123}']) {
      expect(collectDiagnostics({ capabilityPath: '/x', fsImpl: { readFileSync: () => raw }, osImpl: leakyOs, processImpl: leakyProcess }).version).toBeNull()
    }
  })

  it('reads the REAL shipped capability.json when nothing is injected — the version single source', () => {
    const d = collectDiagnostics()
    expect(d.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(Object.keys(d).sort()).toEqual([...DIAGNOSTIC_KEYS].sort())
  })
})

describe('GET /api/diagnostics — the door picks the four keys a SECOND time', () => {
  const front = () =>
    createFrontServer({
      config: { token: TOKEN },
      deps: { capabilityPath: '/x', fsImpl: leakyFs, osImpl: leakyOs, processImpl: leakyProcess },
    })

  it('answers the four keys and nothing else', async () => {
    const res = await call(front(), mkReq({ url: '/api/diagnostics', headers: bearer() }))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Object.keys(body).sort()).toEqual([...DIAGNOSTIC_KEYS].sort())
    expect(body).toEqual({ version: '5.3.0', platform: 'win32', release: '10.0.26200', node: 'v24.14.1' })
  })

  it('is auth-gated like every other route, and its 401 says nothing', async () => {
    const res = await call(front(), mkReq({ url: '/api/diagnostics' }))
    expect(res.statusCode).toBe(401)
    expect(res.body).toBe('unauthorized')
  })

  it('answers even with NOTHING wired — a person who cannot report a bug is stuck with it', async () => {
    const res = await call(createFrontServer({ config: { token: TOKEN }, deps: {} }), mkReq({ url: '/api/diagnostics', headers: bearer() }))
    expect(res.statusCode).toBe(200)
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual([...DIAGNOSTIC_KEYS].sort())
  })
})

describe('POST /api/update/run — an update never starts by itself', () => {
  function mkRunner(over: any = {}) {
    const calls: any[] = []
    const runner = async (args: any) => {
      calls.push(args)
      return {
        ok: true,
        installed: '5.3.0',
        to: '5.4.0',
        source: 'npm',
        sources: [
          { id: 'npm', version: '5.4.0', verdict: 'update-available' },
          { id: 'local', version: '5.3.0', verdict: 'up-to-date' },
        ],
        ...(args.apply ? { applied: { ran: true, exitCode: 0 } } : {}),
        ...over,
      }
    }
    return { runner, calls }
  }

  const front = (runner: any) => createFrontServer({ config: { token: TOKEN }, deps: { updateRunner: runner } })

  const post = (body: any) => mkReq({ method: 'POST', url: '/api/update/run', headers: jsonHeaders(), body })

  it('confirm:false is a DRY RUN — the applying path is never reached', async () => {
    const { runner, calls } = mkRunner()
    const res = await call(front(runner), post({ confirm: false }))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.dryRun).toBe(true)
    expect(body.installed).toBe('5.3.0')
    expect(body.sources).toEqual([
      { id: 'npm', version: '5.4.0', verdict: 'update-available' },
      { id: 'local', version: '5.3.0', verdict: 'up-to-date' },
    ])
    expect(body.receipt).toBeUndefined()
    // the RECORDED fact, not a reading of the code: the runner was told not to apply
    expect(calls).toEqual([{ apply: false }])
  })

  it('an EMPTY body is a 400 and calls the runner ZERO times — a route sweep is not a question', async () => {
    const { runner, calls } = mkRunner()
    const res = await call(front(runner), post({}))
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('confirm')
    expect(calls).toEqual([])
  })

  it('a non-boolean confirm is refused before anything runs', async () => {
    for (const confirm of ['true', 1, null, {}]) {
      const { runner, calls } = mkRunner()
      const res = await call(front(runner), post({ confirm }))
      expect(res.statusCode).toBe(400)
      expect(calls).toEqual([])
    }
  })

  it('an unknown key is refused by name, with zero runner calls', async () => {
    const { runner, calls } = mkRunner()
    const res = await call(front(runner), post({ confirm: true, source: 'local' }))
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('source')
    expect(calls).toEqual([])
  })

  it('confirm:true applies and answers with a receipt naming both versions and the source', async () => {
    const { runner, calls } = mkRunner()
    const res = await call(front(runner), post({ confirm: true }))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(calls).toEqual([{ apply: true }])
    expect(body.ok).toBe(true)
    expect(body.dryRun).toBe(false)
    expect(body.applied).toEqual({ ran: true, exitCode: 0 })
    expect(body.receipt).toBe('update:5.3.0->5.4.0@npm')
    // the format is stated in the module, not only assembled by it
    expect(UPDATE_RECEIPT_FORMAT).toBe('update:<from>-><to>@<source>')
  })

  it('a refused apply (installed newer / unreachable source) is ok:false with NO receipt', async () => {
    const { runner } = mkRunner({ ok: false, applied: { ran: false, exitCode: null } })
    const body = JSON.parse((await call(front(runner), post({ confirm: true }))).body)
    expect(body.ok).toBe(false)
    expect(body.applied).toEqual({ ran: false, exitCode: null })
    expect(body.receipt).toBeUndefined()
  })

  it('paths and free-text details never survive the door', async () => {
    const { runner } = mkRunner({
      sources: [{ id: 'local', version: '5.4.0', verdict: 'update-available', label: 'local source (C:/Users/founder/projects/sma)', detail: 'ENOENT C:/Users/founder/.claude' }],
      plan: { command: 'node', args: ['C:/Users/founder/projects/sma/bin/init.mjs', '--local'] },
      preserved: ['.claude/memory/**'],
    })
    const raw = (await call(front(runner), post({ confirm: false }))).body
    expect(raw).not.toContain('C:/Users/founder')
    expect(raw).not.toContain('init.mjs')
    expect(raw).not.toContain('ENOENT')
    expect(JSON.parse(raw).sources).toEqual([{ id: 'local', version: '5.4.0', verdict: 'update-available' }])
  })

  it('an updater that throws is a 503 whose body quotes nothing of it', async () => {
    const front2 = createFrontServer({
      config: { token: TOKEN },
      deps: {
        updateRunner: async () => {
          throw new Error('spawn npx ENOENT in C:/Users/founder/projects/sma')
        },
      },
    })
    const res = await call(front2, post({ confirm: false }))
    expect(res.statusCode).toBe(503)
    expect(res.body).not.toContain('C:/Users/founder')
  })

  it('a daemon wired with no updater answers 501 — «not available here», never a silent no-op', async () => {
    const res = await call(createFrontServer({ config: { token: TOKEN }, deps: {} }), post({ confirm: false }))
    expect(res.statusCode).toBe(501)
  })
})

describe('the two filled slots lost their keys in the same commit', () => {
  it('neither door is named in PENDING_ROUTES any more', () => {
    expect(PENDING_ROUTES.has('GET /api/diagnostics')).toBe(false)
    expect(PENDING_ROUTES.has('POST /api/update/run')).toBe(false)
  })
})
