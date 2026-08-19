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
 * the entire frozen route table asserting that no FILLED route answers 501.
 *
 * WHAT A 501 MEANS (server.mjs law): «a collaborator THIS daemon was not wired with» —
 * never «not written yet». On a fully-configured daemon (the config here declares the hub
 * role, so the federation engine is constructed too) that answer must be unreachable.
 *
 * THE ONE EXCEPTION IS DECLARED, NOT ASSUMED: the routes named in PENDING_ROUTES were
 * written into the frozen table before their handlers existed, so that every screen is built
 * against the final contract. They are skipped by the sweep above and get a sweep of their
 * OWN below — where 501 is the assertion rather than the failure, because for a declared
 * slot the question is not «does it work» but «can it be reached at all».
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

import { createDaemon, describeBootFailure, runProjectVerb } from '../src/main.mjs'
import { ROUTES, PENDING_ROUTES } from '../src/front/server.mjs'
import { resolveExpireMs } from '../src/queue/adapter.mjs'

const TOKEN = 'c'.repeat(64)

let tmpRoot: string
let projectDir: string
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
  'select-p1': { id: 'p1' },
  'select-p2': { id: 'p2' },
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
  // A second project that names a REAL folder — the watcher has somewhere to move to.
  projectDir = join(tmpRoot, 'connected')
  mkdirSync(join(projectDir, '.claude', 'memory'), { recursive: true })
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
      // an expiry the operator chose, deliberately NOT the shipped default: a wiring that
      // drops it on the floor is then visible as the default rather than as this number.
      expireMs: 300000,
      repoDir,
      dataDir: join(tmpRoot, 'data'),
      ledgerDir: join(tmpRoot, 'ledger'),
      projects: [{ id: 'p1', name: 'p1' }, { id: 'p2', name: 'p2', path: join(tmpRoot, 'connected') }],
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
      'launchDir',
    ]) {
      expect(deps[name], `deps.${name} is missing from the production wiring`).toBeTruthy()
    }
  })

  /**
   * THE GAP THIS CASE EXISTS FOR — the most expensive one this root ever had.
   *
   * A worker is spawned in two moves: `buildArgs` assembles the spec, `spawnWorker` starts it.
   * Only the second was ever wired. The loop guards against that honestly — `executorBlocker`
   * refused every task with «задачу некому запустить» — so the daemon never lied; it simply
   * could not run a single task, for an entire release line, while its screens, its queue and
   * its gates all worked.
   *
   * Why no existing test caught it: every loop test injects its OWN buildArgs, because that is
   * how you test a loop. The parts were all green. A wiring gap is invisible to the parts and
   * visible only here, where the question is «what did the root actually build?» — so the root
   * returns what it wired, and this asks it.
   */
  it('wires everything a task needs to actually run — all three, not two of three', () => {
    // Each of these was missing at some point, and each failure looked like something else:
    // buildArgs → «задачу некому запустить» on every tick; verbRunner → a code task dying in
    // 300 ms with «среда исполнения недоступна» while the routing journal showed a perfectly
    // good worker, because the worktree verb could not run and the spawn got a cwd that does
    // not exist. Listing them together is the point: two of three wired is still zero tasks.
    for (const name of ['buildArgs', 'spawnWorker', 'verbRunner', 'bookUsage']) {
      expect(typeof park.tickDeps[name], `tickDeps.${name} must be a function or no task can ever run`).toBe('function')
    }
  })

  /**
   * …AND EVERYTHING A FINISHED TASK NEEDS TO BE JUDGED, WHICH IS A SEPARATE LIST.
   *
   * The four above decide whether a session starts. These decide what happens to its work
   * afterwards, and their absence is far quieter: the task runs, the worker does the job
   * correctly, and the tick then refuses it.
   *
   *   execGit — three of the four exit gates ask git whether the work is really on the branch.
   *     Unwired, git answers nothing and all three say no: a committed document fails with «есть
   *     на диске, но не закоммичен», a checkpoint with open questions fails instead of parking
   *     for a person, and an attempt that correctly changed no code falls through to «нет
   *     квитанции» — the exact red row the answer-only gate exists to prevent.
   *   resolveWorkerContext — «включён» in the roster means the role file and skills reach the
   *     session. Unwired, the switch writes config and changes nothing about any spawn, and the
   *     journal's memory layer — written inside the same branch — is never recorded either.
   *   report — the outbound event edge. It stays silent by default and must still be WIRED,
   *     or `webhookUrl` is a knob connected to nothing.
   *
   * Each was fully written and fully tested when this test was added. That is the whole point
   * of asking the root: a part cannot see that nobody joined it to the machine.
   */
  /**
   * …AND THE SESSION THE WORKER IS ACTUALLY HANDED, WHICH IS A FOURTH LIST.
   *
   * The three above decide whether a process starts and how its work is judged. These decide
   * WHAT KIND OF SESSION it is, and their absence is the quietest failure of all — quiet in
   * both directions.
   *
   *   mirrorPersonalLayer — the founder’s instructions, his hooks and his narrowing permissions
   *     are put into the worker’s account before the spawn, and the hosted-connectors switch is
   *     written there with them. Unwired, the module is one nobody calls: the account keeps
   *     whatever it happened to hold, and because the argument builder refuses a spawn whose
   *     account was never mirrored, an unwired root refuses EVERY task by name — the same shape
   *     of failure as the missing builder this file was written for.
   *     It is also what puts the `personalLayer` key on the attempt row: unwired, that key is
   *     simply never written, and «the worker ran under my rules» becomes an unfalsifiable claim.
   *   loadMcpRegistry — which servers a worker may be given. Unwired, the switches in the window
   *     write a registry no spawn ever reads.
   *   dataDir — where the per-spawn config file is written. Unwired, no such file exists and the
   *     session silently takes whatever servers the vendor attaches on its own.
   */
  it('wires the session the worker is HANDED — the personal layer and our servers', () => {
    for (const name of ['mirrorPersonalLayer', 'loadMcpRegistry']) {
      expect(
        typeof park.tickDeps[name],
        `tickDeps.${name} must be wired or every spawn runs under a profile nobody chose`,
      ).toBe('function')
    }
    expect(typeof park.tickDeps.dataDir, 'tickDeps.dataDir must name where the per-spawn mcp config is written').toBe(
      'string',
    )
  })
  it('wires everything a finished task needs to be JUDGED — not just to start', () => {
    for (const name of ['execGit', 'resolveWorkerContext', 'report']) {
      expect(typeof park.tickDeps[name], `tickDeps.${name} must be wired or correct work is refused`).toBe('function')
    }
  })

  /**
   * …AND WHAT HAPPENS TO THE COPY THE WORK WAS DONE IN, WHICH IS A THIRD LIST AGAIN.
   *
   * Every task runs in its own copy on its own branch, and until now nothing ever removed
   * one: the approval door merged the branch and walked away, and the tick had no sweep at
   * all. Both halves of the cure are ordinary functions with their own tests — and both are
   * useless unwired, in the exact way this file exists to catch. The two are named together
   * because they cover different tasks: the door covers the accepted ones, the sweep covers
   * every other closed one, and either alone leaves copies on disk forever.
   */
  it('wires the cleanup of the copy a task ran in — the door for accepted work, the tick for the rest', () => {
    expect(
      typeof park.front.deps.worktreeCleanup,
      'front deps.worktreeCleanup must be wired or accepted work leaves its copy and branch behind',
    ).toBe('function')
    expect(
      typeof park.tickDeps.sweepWorktrees,
      'tickDeps.sweepWorktrees must be wired or copies of closed tasks are never swept',
    ).toBe('function')
  })

  /**
   * THE MONEY RULE MUST REACH THE DISPATCHER.
   *
   * `shouldApiFallback` decides two things nothing else decides: whether a task that names
   * the paid channel by hand is ALLOWED to spend, and whether a fleet with every window shut
   * may continue on that channel instead of waiting. It was written, tested, and called by
   * nobody — so an explicit `provider:'api'` task ran with no ceiling at all, while three
   * screens (Расходы, Правила, Аккаунты) described a budget stop that did not exist.
   *
   * A part cannot see that it was never joined. The root can.
   */
  it('joins the MONEY rule to the dispatcher — a cap nobody consults is a cap that does not exist', () => {
    expect(typeof park.tickDeps.budget, 'tickDeps.budget must be wired or the spending cap is decoration').toBe(
      'function',
    )
    // and it must answer in the shape the router reads, for both questions it is asked
    const verdict = park.tickDeps.budget({ task: { lane: 'prod' }, allClosed: true })
    expect(verdict).toBeTruthy()
    expect(typeof verdict.fallback).toBe('boolean')
    expect(typeof verdict.reason).toBe('string')
  })

  /**
   * THE WINDOW GATE IS ASKED WITH A WORKER AND THE WINDOW MODULE ANSWERS ABOUT AN ACCOUNT.
   *
   * Two callers, two nouns: the front asks about an account because that is what its screen
   * lists, the router asks about a WORKER because that is what it is choosing between. The
   * module reads `.name` off whatever it is handed, and a worker has no `name` — so the
   * router's question resolved to a state read from a file named after nothing, while the
   * usage estimate behind it, given no account to filter by, summed the whole machine.
   *
   * Both directions were live: a subscription the vendor itself reported as spent still
   * received work, and on a busy machine every worker could cross 100% together and idle the
   * conveyor while the real accounts were fresh. No test of either half could see it — the
   * router's tests inject a predicate, the window's tests pass an account. Only the root joins
   * the two nouns, so only the root can be asked whether they agree.
   */
  it('the window gate answers about the WORKER the router hands it, not about nothing', () => {
    const open = park.tickDeps.windows
    expect(typeof open, 'the tick must be given a window predicate').toBe('function')

    // A REAL, SPENT WINDOW ON DISK — the record markWindowObserved writes, for ONE account.
    // Asserting shapes would prove nothing here: with no data every account reads 0% and the
    // gate says «open» whatever name it looked up, including no name at all. The bug is only
    // visible when the answer must DIFFER between two accounts.
    const windowsDir = join(tmpRoot, 'data', 'windows')
    mkdirSync(windowsDir, { recursive: true })
    writeFileSync(
      join(windowsDir, 'acct-spent.json'),
      JSON.stringify({
        accountName: 'acct-spent',
        observed: { five_hour: { utilization: 1, resetsAt: Date.now() + 3_600_000, at: new Date().toISOString() } },
      }),
      'utf8',
    )

    // the shape routing really passes: a worker whose account is one level down
    expect(open({ id: 'w1', lane: 'prod', account: { name: 'acct-spent' } }), 'a spent subscription must stop receiving work').toBe(false)
    expect(open({ id: 'w2', lane: 'prod', account: { name: 'acct-fresh' } }), 'a fresh subscription must keep it').toBe(true)
    // …and the shape the front passes still works, because it is the same seam
    expect(open({ name: 'acct-spent' })).toBe(false)
  })

  /**
   * The phase cycle is ONE decision expressed in two places: which tree the card reads, and
   * which tree a documentary stage is written into. They are allowed to be any directory; they
   * are not allowed to be DIFFERENT directories. A card reading one root while the stage writes
   * into another shows work as never started while the daemon is completing it — and it is the
   * kind of disagreement that survives every unit test on either side, because each half is
   * correct on its own.
   */
  it('the phase card and the tick look at the SAME tree', () => {
    const front = park.front.deps.phaseCycleDir
    const tick = park.tickDeps.projectDir
    expect(typeof front, 'the front must be told where the phase cycle lives').toBe('function')
    expect(typeof tick, 'the tick must be told where a documentary stage stands').toBe('function')
    expect(front()).toBe(tick())
  })

  /**
   * The config here PINS a repoDir, exactly like the founder's does. TWO different
   * facts leave this root: the tree being served (the pin — every read uses it) and the
   * directory this process started in (the write-time derive baseline). Wiring the served
   * tree into the write seam is what deleted the pin from the founder's file on 05.08.2026,
   * so the separation is asserted here, at the root where it was collapsed.
   */
  it("separates the SERVED repoDir from the daemon's own launch directory", () => {
    const deps = park.front.deps
    expect(deps.repoDir).toBe(join(tmpRoot, 'repo')) // the file's pin wins for the reads
    expect(deps.launchDir).toBe(process.cwd()) // the write baseline is the process's own dir
    expect(deps.launchDir).not.toBe(deps.repoDir)
  })

  it('answers 501 on NO route of the frozen table, except the ones declared unfilled', async () => {
    const stubs: string[] = []
    for (const r of ALL_ROUTES) {
      // A route named in PENDING_ROUTES is SUPPOSED to answer 501 — it was declared before it
      // was written, on purpose. The exemption is read from the export rather than listed
      // here, so a slot that gets filled rejoins this sweep automatically, with no edit.
      if (PENDING_ROUTES.has(r.key)) continue
      const res = await call(r.method, r.path, r.key)
      if (res.statusCode === 501) stubs.push(r.key)
    }
    expect(stubs, `these routes answered «not implemented» from the PRODUCTION build: ${stubs.join(', ')}`).toEqual([])
  })

  /**
   * The other side of the same coin, and the one a declared-first table actually needs: an
   * unfilled route must still be REACHED. 501 here is the proof of reachability — the path
   * resolved through matchRoute, the token was accepted, and the handler ran. A 404 would
   * mean the table and the matcher disagree; a 401 would mean the gate does not know the
   * route; a 500 would mean it was reached and broke. Any of those would let a screen be
   * built against a door that is not merely empty but absent, which is the exact failure
   * declaring the whole table at once exists to prevent.
   */
  it('every declared-but-unfilled route is REACHABLE from the production build', async () => {
    const wrong: string[] = []
    for (const key of PENDING_ROUTES) {
      const [method, pattern] = key.split(' ')
      const path = pattern.replace(':id', 'R-1')
      const res = await call(method, path, key)
      if (res.statusCode !== 501) wrong.push(`${key} → ${res.statusCode}`)
    }
    expect(wrong, `a declared route did not answer «not implemented»: ${wrong.join(', ')}`).toEqual([])
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

  /**
   * The watcher used to bind ONCE, at boot, to whatever project was connected
   * then. Switching projects left it on the old tree: the new project's changes reached the
   * screen only through the SPA's own poll, and the recovery was restarting the daemon.
   * Nothing lied (the liveness seam compares directories and answers `polling` when they
   * differ) — the instant hint was simply gone until a restart.
   *
   * This is asserted through the PRODUCTION wiring rather than a hand-built server, because
   * the bug was in the wiring: the handler and the watcher were each fine on their own.
   */
  it('a project switch re-targets the watcher, with no restart', async () => {
    const liveness = park.front.deps.projectLiveness
    expect(park.front.deps.onProjectSelected, 'the select door has no re-target seam wired').toBeTypeOf('function')
    expect(liveness()).toBe('polling') // p1 names no folder: nothing to watch, and it says so

    const res = await call('POST', '/api/project/select', 'select-p2')
    expect(res.statusCode).toBe(200)
    expect(liveness()).toBe('live')

    // back to the project with no folder: the watcher is stopped, not left on the old tree
    const back = await call('POST', '/api/project/select', 'select-p1')
    expect(back.statusCode).toBe(200)
    expect(liveness()).toBe('polling')
  })

  /**
   * TWO LIVENESS CLOCKS WERE RUNNING. The tick's sweep read `config.expireMs`; the durable
   * queue was constructed without it and its lease therefore always ran on the built-in
   * default. Both numbers decide the same thing — when a silent worker's task returns to the
   * queue — so a config that moved one of them moved only one, and the two disagreed with
   * nothing in the product saying so. The root is where they are joined: the SAME resolved
   * value reaches the lease and the sweep.
   */
  it('hands the config expiry to the durable lease, not only to the sweep', () => {
    expect(resolveExpireMs(park.config)).toBe(300000)
    expect(park.adapter.expireMs, 'the durable queue was built without the config expiry').toBe(300000)
  })

  it('derives a working data/ledger dir even from a config that names neither', () => {
    // the file above names both; the DEFAULTING path is proven in config.test.ts. Here we
    // only pin that the root actually HANDS them on — an undefined ledgerDir is how a
    // failed attempt used to lose its reason.
    expect(park.front.deps.ledgerDir).toBeTruthy()
    expect(park.front.deps.dataDir).toBeTruthy()
  })
})

/**
 * runProjectVerb — the two laws learned from the lint door that hung forever (QA D2,
 * 11.08.2026). execFile's callback waits for the child's stdio pipe, not for the child:
 * a grandchild holding the inherited pipe keeps the callback from firing even after the
 * timeout kills the child, so the door had NO path to an answer. And the grandchild
 * existed at all because a daemon-spawned verb was not told it is headless.
 */
describe('runProjectVerb — the door answers, and its children are headless', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'sma-verb-'))
  beforeAll(() => {
    // the runtime layout the guard checks for, so the exec path is actually reached
    mkdirSync(join(projectDir, 'scripts', 'sma'), { recursive: true })
    writeFileSync(join(projectDir, 'scripts', 'sma', 'cli.mjs'), '// stub — never executed: execFileImpl is injected\n')
  })
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }))

  it('answers with an honest refusal when the callback never fires (the held-pipe hang)', async () => {
    const r = await runProjectVerb({ verb: 'lint', args: ['--json'], projectDir }, { execFileImpl: () => {}, timeoutMs: 20 })
    expect(r.ok).toBe(false)
    expect(String(r.reason)).toContain('did not answer')
  })

  it('tells every child it is headless: SMA_DISABLE_SNAPSHOT_SPAWN rides the env', async () => {
    let seen: any = null
    const execFileImpl = (_bin: any, _args: any, opts: any, cb: any) => {
      seen = opts
      cb(null, '{"ok":true}')
    }
    await runProjectVerb({ verb: 'lint', args: [], projectDir }, { execFileImpl })
    expect(seen.env.SMA_DISABLE_SNAPSHOT_SPAWN).toBe('1')
  })
})
