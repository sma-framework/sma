/**
 * Tests for daemon/src/main.mjs — THE PRODUCTION COMPOSITION ROOT.
 *
 * WHY THIS FILE EXISTS. Every front route is dependency-injected, and every front test
 * until now assembled its OWN server with exactly the collaborators that test needed. That
 * is a fine way to test a HANDLER and a blind spot about the DAEMON: five collaborators
 * (execGit, casExec, readHarness, the appliers, the MCP registry loader) were never wired
 * in main.mjs, so a real install answered «not implemented» to approve, return, diff, the
 * whole agents screen and all three toggles — while the suite stayed green. Grep cannot
 * see an absence; a test that builds an artificial server cannot see it either. So this
 * one builds THE REAL ONE — `createDaemon()` with NO collaborator overrides — and sweeps
 * the entire frozen route table asserting that not one route answers 501.
 *
 * WHAT A 501 MEANS (server.mjs law): «a collaborator THIS daemon was not wired with» —
 * never «not written yet». On a fully-configured daemon (the config here declares the hub
 * role, so the federation engine is constructed too) that answer must be unreachable.
 *
 * NOTHING REAL IS TOUCHED: SMA_DAEMON_CONFIG points at a temp config whose repoDir,
 * dataDir and ledgerDir are temp dirs, and whose queueUrl points at a closed port — the
 * daemon is never started (no listen, no tick, no pg-boss connection), only WIRED, and the
 * handlers are driven with fake req/res exactly as front-auth.test.ts drives them. Bodies
 * are empty objects on purpose: every POST refuses them at its own validation, so no
 * applier writes and no chat turn spawns anything.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDaemon, describeBootFailure } from '../src/main.mjs'
import { ROUTES } from '../src/front/server.mjs'

const TOKEN = 'c'.repeat(64)

let tmpRoot: string
let park: any
const savedEnv: Record<string, string | undefined> = {}

// ── fake req/res (same shape as front-auth.test.ts) ──

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
    write() {
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

/**
 * The body a route needs to REACH its dependency check. Most handlers ask «am I wired?»
 * first and an empty object is enough; approve and return validate their taskId FIRST, so
 * an empty body would answer 400 and hide the very 501 this sweep exists to catch.
 */
const BODIES: Record<string, object> = {
  'POST /api/approve': { taskId: 'R-1' },
  'POST /api/return': { taskId: 'R-1', note: 'нет' },
}

/** Every route of the frozen table, dynamic segments filled — derived, never hand-kept. */
const ALL_ROUTES = Object.keys(ROUTES).map((key) => {
  const [method, pattern] = key.split(' ')
  return { method, key, path: pattern.replace(':id', 'R-1').replace(':file', 'app-abc123.js') }
})

async function call(method: string, path: string, key: string) {
  const req = mkReq({
    method,
    url: path,
    headers:
      method === 'POST'
        ? { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
        : { authorization: `Bearer ${TOKEN}` },
    ...(method === 'POST' ? { body: BODIES[key] ?? {} } : {}),
  })
  const res = mkRes()
  await park.front.handle(req, res)
  return res
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sma-composition-'))
  const repoDir = join(tmpRoot, 'repo')
  mkdirSync(repoDir, { recursive: true })
  const configPath = join(tmpRoot, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      // a CLOSED port: the daemon is wired but never started, and any handler that does
      // reach the queue gets a refused connection (which is a 5xx, never a 501).
      queueUrl: 'postgres://127.0.0.1:1/sma_none',
      bind: '127.0.0.1',
      port: 7999,
      token: TOKEN,
      repoDir,
      dataDir: join(tmpRoot, 'data'),
      ledgerDir: join(tmpRoot, 'ledger'),
      projects: [{ id: 'p1', name: 'p1' }],
      activeProject: 'p1',
      // hub, so the federation engine is constructed: the three machine routes are then
      // wired like every other one and may not answer «not available here» either.
      federation: { role: 'hub', peers: [] },
      workers: [
        {
          id: 'max-1',
          lane: 'prod',
          provider: 'claude',
          enabled: true,
          account: { name: 'max-1', configDir: join(tmpRoot, 'accounts', 'max-1') },
        },
      ],
    }),
    'utf8',
  )
  for (const key of ['SMA_DAEMON_CONFIG', 'SMA_DAEMON_MCP']) savedEnv[key] = process.env[key]
  process.env.SMA_DAEMON_CONFIG = configPath
  process.env.SMA_DAEMON_MCP = join(tmpRoot, 'absent-mcp.json') // absent → {servers:[]}

  // THE PRODUCTION FACTORY, no overrides. Nothing is started: createDaemon only wires.
  park = createDaemon()
})

afterAll(async () => {
  try {
    if (park && park.hub && typeof park.hub.close === 'function') park.hub.close()
    if (park && park.daemon && typeof park.daemon.stop === 'function') park.daemon.stop()
  } catch {
    /* best-effort */
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('the production composition root is COMPLETE', () => {
  it('wires the collaborators the front cannot answer without', () => {
    const deps = park.front.deps
    for (const name of [
      'adapter',
      'hub',
      'ledger',
      'deriveState',
      'execGit',
      'casExec',
      'readHarness',
      'loadMcpRegistry',
      'applyAgentToggle',
      'applySkillAssign',
      'applyMcpToggle',
      'verbRunner',
      'addProject',
      'addPeer',
      'handleChatTurn',
    ]) {
      expect(deps[name], `deps.${name} is missing from the production wiring`).toBeTruthy()
    }
  })

  it('answers 501 on NO route of the frozen table', async () => {
    const stubs: string[] = []
    for (const r of ALL_ROUTES) {
      const res = await call(r.method, r.path, r.key)
      if (res.statusCode === 501) stubs.push(r.key)
    }
    expect(stubs, `these routes answered «not implemented» from the PRODUCTION build: ${stubs.join(', ')}`).toEqual([])
  })

  it('names the cause when the boot dies on an unreachable queue', () => {
    // node's dual-stack connect rejects with an AggregateError whose own message is EMPTY:
    // the whole diagnosis used to read «fatal boot error: AggregateError».
    const inner: any = new Error('connect ECONNREFUSED 127.0.0.1:5432')
    inner.code = 'ECONNREFUSED'
    const agg: any = new AggregateError([inner])
    const said = describeBootFailure(agg, { queueUrl: 'postgres://sma:secret@127.0.0.1:5432/sma_daemon' })

    expect(said).toContain('PostgreSQL')
    expect(said).toContain('127.0.0.1:5432')
    expect(said).toContain('ECONNREFUSED')
    expect(said).toContain('docs/INSTALL.md')
    expect(said).not.toContain('secret') // the connection string never rides a log line
    expect(said).not.toBe('AggregateError')
  })

  it('passes a plain error through unchanged (masked)', () => {
    expect(describeBootFailure(new Error('queue url is malformed'), {})).toBe('queue url is malformed')
  })

  it('derives a working data/ledger dir even from a config that names neither', () => {
    // the file above names both; the DEFAULTING path is proven in config.test.ts. Here we
    // only pin that the root actually HANDS them on — an undefined ledgerDir is how a
    // failed attempt used to lose its reason.
    expect(park.front.deps.ledgerDir).toBeTruthy()
    expect(park.front.deps.dataDir).toBeTruthy()
  })
})
