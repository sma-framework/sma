/**
 * live-crash-drill.mjs — the crash/restart drill against a REAL PostgreSQL and a REAL
 * process kill. The one question the hermetic drills cannot answer.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. `daemon/__tests__/fleet-drill.test.ts` runs five
 * drills against a stateful fake queue over plain maps with an injected clock. That is the
 * right shape for a test that must pass on a machine with nothing installed, and it proves
 * the RECOVERY LOGIC. It cannot prove DURABILITY: that a row survives a real process kill,
 * that the transaction boundaries hold, that live pg-boss behaves the way the fake models
 * it. This script answers exactly that, once, on a real cluster, and writes down what it
 * saw — including the parts that do not flatter the product.
 *
 * THE SHAPE OF THE DRILL
 *   1. Ensure the drill database exists on a running cluster. Its OWN database, its OWN
 *      front port, its OWN config and data directories — nothing here shares state with a
 *      daemon that may already be serving someone.
 *   2. Boot the REAL entrypoint (`node daemon/src/main.mjs`) as a CHILD PROCESS. Not
 *      `createDaemon()` in-process: a drill about killing a process needs a process to kill.
 *      The child is pointed at its own config through `SMA_DAEMON_CONFIG` — the seam the
 *      config loader already publishes, so no product change is needed to run a second
 *      instance beside a live one.
 *   3. Enqueue through the product's own door: `POST /api/enqueue` with the front token.
 *   4. Watch the DATABASE (not the daemon's own report) until pg-boss shows a job `active`,
 *      and kill the process at that instant. On Windows there is no POSIX SIGKILL;
 *      `child.kill('SIGKILL')` becomes `TerminateProcess`, which is the platform's hard
 *      kill — no handler runs, no flush, no graceful shutdown. That is the honest
 *      equivalent and the report names it.
 *   5. Take the census FROM THE DATABASE before and after, restart, and watch what the
 *      queue does with a job whose worker died unobserved.
 *
 * THE CENSUS IS SQL, NOT THE ADAPTER. `adapter.list()` is the product's own read model and
 * would be a witness to its own case. The census here is a plain SELECT over `pgboss.job`,
 * keyed on the pg-boss job UUID — which survives even pg-boss's own timeout path, since
 * that path deletes and re-inserts the row carrying its id forward.
 *
 * WHAT «NOT LOST» MEANS HERE, stated so it cannot be read more generously than it is:
 * every pg-boss job id present before the kill is present after it, and its state is the
 * same one or a LEGAL SUCCESSOR (`SUCCESSORS` below). A terminal state that moved, or an id
 * that vanished, fails the drill.
 *
 * THE RECONSTRUCTED ROW, AND THE TWO OBSERVERS. `daemon/src/queue/reconcile.mjs` writes an
 * attempt-ledger row carrying `reconstructed: true` for an attempt NOBODY observed. A dead
 * attempt has two possible observers and only the second one leaves that trace:
 *
 *   the daemon's own liveness sweep   runs every tick, calls `adapter.fail(id,
 *                                     'runtime_offline')`, and the adapter writes a normal
 *                                     attempt row. Nothing to reconstruct afterwards.
 *   pg-boss's own lease expiry        runs inside a pg-boss supervise pass, once a minute,
 *                                     and writes nothing to the ledger. THIS is the gap
 *                                     reconcile.mjs fills, on the next restart.
 *
 * ON A SINGLE DAEMON OWNING ITS OWN QUEUE DATABASE THE SWEEP ALWAYS WINS. Both mechanisms
 * use the same 120 s threshold, the sweep is asked every tick and supervise once a minute,
 * and while the daemon is dead nothing supervises at all — so the unobserved branch does not
 * occur by itself, and this drill does not pretend it did. `--sweep-expire-ms`, larger than
 * the queue's own lease, holds the sweep back so pg-boss expires the lease first; that is
 * the arrangement under which the reconstructed row can be observed live, and a run that
 * uses it says so in its own transcript.
 *
 * WHAT IT NEEDS
 *   - a PostgreSQL already running (this script never starts or stops one; bring the
 *     sandbox up with `node supervisor/pg-sandbox-windows.mjs start`);
 *   - `pg` and `pg-boss` installed (the daemon's two runtime dependencies);
 *   - a free front port for the drill daemon (default 7779 — NEVER 7777, which a live
 *     window may be using).
 *
 * USAGE
 *   node tools/live-crash-drill.mjs [options]
 *     --queue-url <url>   default postgres://postgres:postgres@127.0.0.1:5433/sma_drill
 *     --port <n>          drill front port          (default 7779)
 *     --root <dir>        drill config/data/ledger  (default <tmp>/sma-live-crash-drill)
 *     --tasks <n>         tasks to enqueue per boot (default 3)
 *     --kill-attempts <n> retries to catch a job mid-claim (default 5)
 *     --recover-ms <ms>   how long to watch after the restart (default 420000)
 *     --sweep-expire-ms <ms>  hold the daemon's liveness sweep back (see above; absent =
 *                             the default arrangement, where the sweep observes the death)
 *     --keep              leave the drill root on disk for inspection
 *
 * EXIT CODES: 0 the drill ran and every assertion held; 1 an assertion failed; 2 a
 * precondition was missing (no cluster, no `pg`, port busy).
 *
 * EXPECTED SHAPES — what the two reference runs produced, so a later run can be compared
 * rather than merely repeated (2026-08-05, embedded PG18 on :5433, pg-boss 11.1.2, Node 22,
 * Windows 11; 3 tasks, --tick-ms 250):
 *
 *   census A (after enqueue)  3 rows, state=created, retry_count=0, attempt=1
 *   census B (at the kill)    the killed task state=active with started_on set, the rest
 *                             untouched; the kill landed on the first try in both runs
 *   census C (after restart)  every job id from A and B present; a task whose retries are
 *                             exhausted is state=failed with retry_count=2 AND a
 *                             dead-letter copy (state=created) in sma.task.dead
 *   assertions                no task lost, no illegal transition, in both runs
 *
 *   run 1, default arrangement:
 *     at started_on + 120 s exactly, the daemon's own liveness sweep failed the stranded
 *     attempt and the adapter wrote the attempt-1 row; reconcile.mjs correctly wrote
 *     nothing. The task then ran out its retries: failed, retry_count=2, attempt=3.
 *   run 2, --sweep-expire-ms 900000:
 *     pg-boss's supervise expired the lease first (t+121 s after the restart), the ledger
 *     held no attempt-1 row, and at t+123 s reconcile.mjs appended exactly
 *       {"taskId":…,"attempt":1,"outcome":"failed","failureReason":"runtime_offline",
 *        "reconstructed":true,"recordedAt":…}
 *     — no workerId, no provider, no receipt, and `recordedAt` the moment of reconciliation
 *     rather than a fabricated moment of the attempt. The task was then at retry,
 *     retry_count=1, attempt=2.
 *
 * Node built-ins + `pg` + the daemon's own attempt-ledger reader. It writes only inside the
 * drill root and the drill database, and it never touches ~/.sma-daemon.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readAttempts } from '../daemon/src/queue/attempt-ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

/** The queues the census covers: the four lanes plus the shared dead letter. */
const QUEUE_NAMES = Object.freeze([
  'sma.task.prod',
  'sma.task.research',
  'sma.task.paperwork',
  'sma.task.forge',
  'sma.task.dead',
])

/**
 * The states a pg-boss job may legally be in AFTER a crash, given the state it was in
 * BEFORE. Read as «from -> the set it may now be found in».
 *
 * `active -> retry` is the whole point of the drill: a lease that expired with nobody
 * watching returns the job to the queue. `completed`/`failed`/`cancelled` map only to
 * themselves — a terminal state that moved is data loss wearing a different hat.
 */
const SUCCESSORS = Object.freeze({
  created: ['created', 'retry', 'active', 'completed', 'failed', 'cancelled'],
  retry: ['retry', 'active', 'completed', 'failed', 'cancelled'],
  active: ['active', 'retry', 'completed', 'failed', 'cancelled'],
  completed: ['completed'],
  failed: ['failed'],
  cancelled: ['cancelled'],
})

let failures = 0
const pass = (msg) => console.log(`PASS  ${msg}`)
const fail = (msg) => {
  failures += 1
  console.log(`FAIL  ${msg}`)
}
const info = (msg) => console.log(`  ..  ${msg}`)
const head = (msg) => console.log(`\n=== ${msg} ===`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── plumbing ──────────────────────────────────────────────────────────────────────────

/** The `pg` client, from the repository tree or the daemon's vendored copy. */
async function loadPg() {
  const require = createRequire(import.meta.url)
  const resolved = require.resolve('pg', { paths: [HERE, REPO, join(REPO, 'daemon')] })
  const mod = await import(pathToFileURL(resolved).href)
  return mod.default ?? mod
}

function probePort(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* nothing depends on a socket we are done with */
      }
      resolve(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

// ── the census ────────────────────────────────────────────────────────────────────────

/**
 * census(client) → one row per pg-boss job, read with SQL.
 *
 * `attempt` is computed with the SAME arithmetic the product uses
 * (`data.attempt + retry_count`, pgboss-backend.mjs `attemptNumberOf`) so the census and
 * the daemon are talking about the same number.
 */
async function census(client) {
  const res = await client.query(
    `SELECT id::text            AS job_id,
            name                AS queue,
            data->>'id'         AS task_id,
            state::text         AS state,
            retry_count         AS retry_count,
            COALESCE((data->>'attempt')::int, 1) + retry_count AS attempt,
            started_on, created_on, completed_on,
            output
       FROM pgboss.job
      WHERE name = ANY($1)
      ORDER BY created_on, id`,
    [QUEUE_NAMES],
  )
  return res.rows
}

/** The census as a table a person can read in a report. */
function printCensus(label, rows) {
  console.log(`  ${label} — ${rows.length} row(s)`)
  console.log(`  ${'task'.padEnd(16)} ${'queue'.padEnd(16)} ${'state'.padEnd(10)} ${'retry'.padEnd(6)} ${'attempt'.padEnd(8)} started_on`)
  for (const r of rows) {
    console.log(
      `  ${String(r.task_id).padEnd(16)} ${String(r.queue).padEnd(16)} ${String(r.state).padEnd(10)} ` +
        `${String(r.retry_count).padEnd(6)} ${String(r.attempt).padEnd(8)} ${r.started_on ? new Date(r.started_on).toISOString() : '-'}`,
    )
  }
}

/**
 * activeRows(rows, taskIds) — the jobs pg-boss currently considers claimed by a worker.
 *
 * Scoped to the ids THIS run enqueued. The drill database accumulates across runs by
 * design (the censuses are the evidence), and a job stranded by an earlier run would
 * otherwise make every later run believe it had caught a claim it never made.
 */
const activeRows = (rows, taskIds) =>
  rows.filter((r) => r.state === 'active' && (!taskIds || taskIds.includes(r.task_id)))

// ── the drill daemon ──────────────────────────────────────────────────────────────────

/**
 * writeDrillConfig(root, {port, queueUrl}) — the drill daemon's OWN config file.
 *
 * `SMA_DAEMON_CONFIG` is the existing seam (config.mjs `resolveConfigPath`), and the two
 * working directories fall out of the config file's own directory (`withDerivedDirs`), so
 * pointing that one variable at the drill root moves the config, the data and the ledger
 * together. Nothing is written to ~/.sma-daemon.
 *
 * The single worker's account directory is CREATED, so `workerReadiness` passes and the
 * claim path runs the length a real one would rather than being refused at the first gate.
 * No executor is wired into the production composition root, so the attempt still ends in
 * an honest `runtime_offline` — no model is called and nothing is spent.
 */
function writeDrillConfig(root, { port, queueUrl, tickMs, sweepExpireMs }) {
  const accountDir = join(root, 'account')
  mkdirSync(accountDir, { recursive: true })
  mkdirSync(join(accountDir, 'spend'), { recursive: true })
  const config = {
    queueUrl,
    bind: '127.0.0.1',
    port,
    token: randomBytes(32).toString('hex'),
    tickMs,
    // `expireMs` is read by the tick's OWN liveness sweep (loop.mjs) and by nothing else —
    // the queue's pg-boss lease is wired separately and stays at its own 120 s. Raising it
    // is how this drill reaches the branch `reconcile.mjs` exists for: with the sweep held
    // back, pg-boss's own lease expiry is the first thing to notice the dead attempt, and
    // nobody writes a ledger row for it. Left absent, both mechanisms sit at 120 s and the
    // sweep — which runs every tick, against supervise's once a minute — always wins.
    ...(sweepExpireMs !== undefined ? { expireMs: sweepExpireMs } : {}),
    backlogScanMinutes: 60,
    agingHours: 24,
    webhookUrl: '',
    budget: { monthlyApiCapEur: 0, warnPct: [70, 90] },
    workers: [
      {
        id: 'drill-1',
        lane: 'prod',
        provider: 'claude',
        account: {
          name: 'drill-1',
          configDir: accountDir,
          oauthTokenEnv: 'SMA_DRILL_1_TOKEN',
          spendLogsDir: join(accountDir, 'spend'),
        },
        enabled: true,
      },
    ],
    // A project with no `path` connects no folder, so no file watcher is started on a tree
    // this drill does not own.
    projects: [{ id: 'sma-drill', name: 'sma-drill' }],
    activeProject: 'sma-drill',
  }
  const configPath = join(root, 'config.json')
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return { configPath, config }
}

/**
 * bootDaemon({configPath, port, log}) — start `node daemon/src/main.mjs` as a child and wait
 * until its front answers. Returns the child handle plus the collected output.
 */
async function bootDaemon({ configPath, port, token, label }) {
  const lines = []
  const child = spawn(process.execPath, [join('daemon', 'src', 'main.mjs')], {
    cwd: REPO,
    env: { ...process.env, SMA_DAEMON_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const collect = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) lines.push(line)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  const deadline = Date.now() + 45000
  let ready = false
  while (Date.now() < deadline && child.exitCode === null) {
    if (await probePort(port)) {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
      if (res && res.status === 200) {
        ready = true
        break
      }
    }
    await sleep(250)
  }
  if (!ready) {
    console.log(lines.map((l) => `      ${l}`).join('\n'))
    throw new Error(`${label}: the drill daemon never answered on :${port} (exit=${child.exitCode})`)
  }
  info(`${label}: pid ${child.pid} answering on 127.0.0.1:${port}`)
  return { child, lines }
}

/** Enqueue through the product's own door. Returns the minted task ids. */
async function enqueueTasks({ port, token, count }) {
  const ids = []
  for (let n = 0; n < count; n += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/api/enqueue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: `live crash drill task ${n + 1}`, lane: 'prod' }),
    })
    const body = await res.json().catch(() => null)
    if (res.status !== 200 || !body || !body.id) throw new Error(`enqueue ${n + 1} answered ${res.status}: ${JSON.stringify(body)}`)
    ids.push(body.id)
    // The front mints `R-<epochMs>`; two calls inside one millisecond would collide on the
    // singleton key, so the calls are spaced rather than raced.
    await sleep(4)
  }
  return ids
}

/**
 * killWhenActive({client, child, deadline}) — watch the DATABASE and hard-kill the daemon
 * the moment pg-boss reports a job `active`.
 *
 * The poll is deliberately short (5 ms) and the query trivially small: between the fetch
 * that claims a job and the failure that releases it the daemon does a routing decision, a
 * readiness check, a journal append and two round trips, which is a window of a few tens of
 * milliseconds. Anything slower than this loop watches the window go past.
 */
async function killWhenActive({ client, child, deadline, taskIds }) {
  while (Date.now() < deadline) {
    const res = await client.query(
      `SELECT data->>'id' AS task_id FROM pgboss.job
        WHERE state = 'active' AND name = ANY($1) AND data->>'id' = ANY($2) LIMIT 1`,
      [QUEUE_NAMES, taskIds],
    )
    if (res.rows.length > 0) {
      const at = Date.now()
      // Windows has no POSIX SIGKILL: node maps this onto TerminateProcess, which is the
      // platform's hard kill — no signal handler, no flush, no graceful shutdown path.
      child.kill('SIGKILL')
      return { killed: true, taskId: res.rows[0].task_id, at }
    }
    await sleep(5)
  }
  return { killed: false }
}

/** Wait for the child to actually be gone; report how it went away. */
function awaitExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: child.exitCode, signal: child.signalCode, timedOut: true }), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

// ── the ledger ────────────────────────────────────────────────────────────────────────

/** Every attempt row the drill's ledger holds, per task, read through the product's reader. */
function ledgerCensus(ledgerDir, taskIds) {
  const out = {}
  for (const id of taskIds) {
    try {
      out[id] = readAttempts(ledgerDir, id) || []
    } catch {
      out[id] = []
    }
  }
  return out
}

function printLedger(byTask) {
  for (const [taskId, rows] of Object.entries(byTask)) {
    if (rows.length === 0) {
      console.log(`  ${taskId}: (no attempt rows)`)
      continue
    }
    for (const r of rows) {
      const flags = [
        `attempt=${r.attempt ?? '-'}`,
        `outcome=${r.outcome ?? '-'}`,
        r.failureReason ? `reason=${r.failureReason}` : null,
        r.reconstructed ? 'RECONSTRUCTED' : null,
        r.workerId ? `worker=${r.workerId}` : null,
        r.receiptRef ? `receipt=${r.receiptRef}` : null,
      ].filter(Boolean)
      console.log(`  ${taskId}: ${flags.join(' · ')}`)
    }
  }
}

// ── argv ──────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    queueUrl: 'postgres://postgres:postgres@127.0.0.1:5433/sma_drill',
    port: 7779,
    root: join(tmpdir(), 'sma-live-crash-drill'),
    tasks: 3,
    killAttempts: 5,
    recoverMs: 420000,
    tickMs: 250,
    sweepExpireMs: undefined,
    keep: false,
  }
  const rest = [...argv]
  while (rest.length) {
    const flag = rest.shift()
    const value = () => {
      const v = rest.shift()
      if (v === undefined) throw new Error(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case '--queue-url': opts.queueUrl = value(); break
      case '--port': opts.port = Number(value()); break
      case '--root': opts.root = value(); break
      case '--tasks': opts.tasks = Number(value()); break
      case '--kill-attempts': opts.killAttempts = Number(value()); break
      case '--recover-ms': opts.recoverMs = Number(value()); break
      case '--tick-ms': opts.tickMs = Number(value()); break
      case '--sweep-expire-ms': opts.sweepExpireMs = Number(value()); break
      case '--keep': opts.keep = true; break
      default: throw new Error(`unknown option "${flag}"`)
    }
  }
  if (opts.port === 7777) throw new Error('refusing --port 7777: that is the daemon\'s default and a live window may be on it')
  return opts
}

// ── the drill ─────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  console.log('=== SMA V5 — live crash/restart drill (real PostgreSQL, real process kill) ===')
  console.log(`  queueUrl=${opts.queueUrl.replace(/\/\/[^@]*@/, '//[masked]@')} front=127.0.0.1:${opts.port} root=${opts.root}`)

  const pg = await loadPg()

  // (0) preconditions — never started or stopped here, only checked.
  const probe = new pg.Client({ connectionString: opts.queueUrl, connectionTimeoutMillis: 5000 })
  try {
    await probe.connect()
    await probe.query('select 1')
  } catch (err) {
    console.error(`PRECONDITION: the drill database did not answer — ${String((err && err.message) || err)}`)
    console.error('  bring the cluster up and create the database with:')
    console.error('    node supervisor/pg-sandbox-windows.mjs start --db sma_drill')
    return 2
  } finally {
    await probe.end().catch(() => {})
  }
  if (await probePort(opts.port)) {
    console.error(`PRECONDITION: 127.0.0.1:${opts.port} is already in use — pick another --port`)
    return 2
  }

  if (existsSync(opts.root)) rmSync(opts.root, { recursive: true, force: true })
  mkdirSync(opts.root, { recursive: true })
  const { configPath, config } = writeDrillConfig(opts.root, {
    port: opts.port,
    queueUrl: opts.queueUrl,
    tickMs: opts.tickMs,
    sweepExpireMs: opts.sweepExpireMs,
  })
  const ledgerDir = join(opts.root, 'ledger')
  info(`config ${configPath} (SMA_DAEMON_CONFIG) — data and ledger derive from its directory`)

  const sql = new pg.Client({ connectionString: opts.queueUrl })
  await sql.connect()
  const watcher = new pg.Client({ connectionString: opts.queueUrl })
  await watcher.connect()

  let boot = null
  let killedTaskId = null
  let killResult = null
  let exitInfo = null
  let censusA = []
  let censusB = []
  let allTaskIds = []

  try {
    // ── (1) BEFORE THE KILL ──────────────────────────────────────────────────────────
    head('1. boot, enqueue, and catch a claim in flight')
    for (let attempt = 1; attempt <= opts.killAttempts; attempt += 1) {
      boot = await bootDaemon({ configPath, port: opts.port, token: config.token, label: `boot ${attempt}` })
      const ids = await enqueueTasks({ port: opts.port, token: config.token, count: opts.tasks })
      allTaskIds = [...new Set([...allTaskIds, ...ids])]
      info(`enqueued via POST /api/enqueue: ${ids.join(', ')}`)

      const beforeKill = await census(sql)
      killResult = await killWhenActive({ client: watcher, child: boot.child, deadline: Date.now() + 60000, taskIds: ids })
      const afterKill = await census(sql)

      if (killResult.killed && activeRows(afterKill, ids).length > 0) {
        censusA = beforeKill
        censusB = afterKill
        killedTaskId = killResult.taskId
        exitInfo = await awaitExit(boot.child)
        pass(`attempt ${attempt}: the daemon was hard-killed with a job ACTIVE in the database (task ${killedTaskId})`)
        break
      }

      // The kill landed outside the claim window. Say so, tear the boot down, try again —
      // a drill that quietly settled for «no job was claimed» would prove nothing.
      info(
        `attempt ${attempt}: kill=${killResult.killed ? 'fired' : 'never fired (no job went active in 60s)'}, ` +
          `active rows right after the kill: ${activeRows(afterKill, ids).length} — retrying`,
      )
      if (boot.child.exitCode === null) boot.child.kill('SIGKILL')
      await awaitExit(boot.child)
      boot = null
      await sleep(500)
    }

    if (!killedTaskId) {
      fail(`no attempt caught a job in the ACTIVE state at the moment of the kill (${opts.killAttempts} attempts)`)
      return failures
    }

    console.log(`  killed at ${new Date(killResult.at).toISOString()} — child exit code=${exitInfo.code} signal=${exitInfo.signal}`)
    console.log('  kill method: child.kill(\'SIGKILL\') → TerminateProcess on win32 (no handler, no flush)')
    head('2. census BEFORE the kill (SQL against pgboss.job)')
    printCensus('census A', censusA)
    head('3. census AT THE KILL (SQL against pgboss.job)')
    printCensus('census B', censusB)

    const stranded = activeRows(censusB, allTaskIds)
    pass(`census B holds ${stranded.length} job(s) left ACTIVE by the crash: ${stranded.map((r) => r.task_id).join(', ')}`)

    // ── (2) RESTART ──────────────────────────────────────────────────────────────────
    head('4. restart the daemon on the same database, config and ledger')
    boot = await bootDaemon({ configPath, port: opts.port, token: config.token, label: 'restart' })

    // ── (3) WATCH THE RECOVERY ───────────────────────────────────────────────────────
    head('5. watch the recovery (pg-boss expires the lease; the tick reconciles the ledger)')
    console.log('  pg-boss expires a lease expire_seconds after the fetch and only notices during its own')
    console.log('  supervise pass, so this wait is minutes, not seconds. Every change is printed as it happens.')
    const deadline = Date.now() + opts.recoverMs
    const startedAt = Date.now()
    let lastSignature = JSON.stringify(censusB.map((r) => [r.job_id, r.state, r.retry_count]))
    let sawLeaveActive = false
    let reconstructed = null
    while (Date.now() < deadline) {
      await sleep(2000)
      const now = await census(sql)
      const signature = JSON.stringify(now.map((r) => [r.job_id, r.state, r.retry_count]))
      if (signature !== lastSignature) {
        lastSignature = signature
        const secs = Math.round((Date.now() - startedAt) / 1000)
        console.log(`  t+${secs}s — queue moved:`)
        printCensus('  now', now)
      }
      const killedRow = now.find((r) => r.task_id === killedTaskId && r.queue !== 'sma.task.dead')
      if (killedRow && killedRow.state !== 'active') sawLeaveActive = true

      const rows = ledgerCensus(ledgerDir, allTaskIds)
      for (const [taskId, list] of Object.entries(rows)) {
        const hit = list.find((r) => r && r.reconstructed === true)
        if (hit) {
          reconstructed = { taskId, row: hit, atSeconds: Math.round((Date.now() - startedAt) / 1000) }
          break
        }
      }
      if (reconstructed) break
    }

    // ── (4) AFTER ────────────────────────────────────────────────────────────────────
    head('6. census AFTER the restart (SQL against pgboss.job)')
    const censusC = await census(sql)
    printCensus('census C', censusC)

    // Assertion 1 — nothing vanished. Keyed on the pg-boss job UUID, which survives even
    // pg-boss's own timeout path (it deletes and re-inserts carrying the id forward).
    const before = new Map([...censusA, ...censusB].map((r) => [r.job_id, r]))
    const after = new Map(censusC.map((r) => [r.job_id, r]))
    const lost = [...before.keys()].filter((id) => !after.has(id))
    if (lost.length === 0) pass(`no task lost: all ${before.size} job id(s) seen before the kill are present after the restart`)
    else fail(`${lost.length} job id(s) vanished across the crash: ${lost.join(', ')}`)

    // Assertion 2 — every state change is a legal successor.
    const illegal = []
    for (const [id, was] of before) {
      const now = after.get(id)
      if (!now) continue
      const legal = SUCCESSORS[was.state] || []
      if (!legal.includes(now.state)) illegal.push(`${was.task_id}: ${was.state} -> ${now.state}`)
    }
    if (illegal.length === 0) pass('every surviving job is in the same state or a legal successor of the one it was in')
    else fail(`illegal state transitions across the crash: ${illegal.join('; ')}`)

    // Assertion 3 — the stranded task came back.
    const killedAfter = censusC.find((r) => r.task_id === killedTaskId && r.queue !== 'sma.task.dead')
    if (killedAfter && killedAfter.state !== 'active') {
      pass(`the abandoned task ${killedTaskId} was returned by the queue: state=${killedAfter.state}, retry_count=${killedAfter.retry_count}, attempt=${killedAfter.attempt}`)
    } else if (killedAfter) {
      fail(`the abandoned task ${killedTaskId} is STILL 'active' after ${Math.round(opts.recoverMs / 1000)}s — its lease never expired inside the drill window`)
    } else {
      fail(`the abandoned task ${killedTaskId} is not in the lane queues at all after the restart`)
    }

    // ── (5) THE LEDGER ───────────────────────────────────────────────────────────────
    head('7. the attempt ledger after the restart')
    const finalLedger = ledgerCensus(ledgerDir, allTaskIds)
    printLedger(finalLedger)
    if (reconstructed) {
      pass(
        `RECONSTRUCTED row observed live at t+${reconstructed.atSeconds}s: task ${reconstructed.taskId}, ` +
          `attempt=${reconstructed.row.attempt}, outcome=${reconstructed.row.outcome}, reason=${reconstructed.row.failureReason}, ` +
          `workerId=${reconstructed.row.workerId ?? '(absent, as designed)'}`,
      )
    } else {
      // NOT a failure, and the difference matters. `reconcile.mjs` reconstructs the attempts
      // NOBODY observed. There are two observers of a dead attempt, and if the first one did
      // its job there is nothing left to reconstruct — an empty reconciliation is then the
      // correct answer, not a broken one. So the drill says WHICH observer won.
      const killedRows = finalLedger[killedTaskId] || []
      const observedFirstAttempt = killedRows.find((r) => r && Number(r.attempt) === 1 && r.reconstructed !== true)
      console.log('NOTE  no reconstructed row appeared inside the drill window. Why, exactly:')
      if (observedFirstAttempt) {
        console.log(`      the daemon's OWN liveness sweep noticed the dead attempt first (row at`)
        console.log(`      ${observedFirstAttempt.recordedAt}, outcome=${observedFirstAttempt.outcome}, reason=${observedFirstAttempt.failureReason})`)
        console.log('      and wrote the attempt-1 row itself, so the reconciliation pass found no gap and')
        console.log('      correctly wrote nothing. That is the OBSERVED branch of the recovery, not the')
        console.log('      unobserved one reconcile.mjs exists for. On a single daemon owning its own queue')
        console.log('      database the sweep always wins that race: it runs every tick, pg-boss supervises')
        console.log('      once a minute, and while the daemon is dead nothing supervises at all.')
        console.log('      To reach the unobserved branch, re-run with --sweep-expire-ms larger than the')
        console.log("      queue's own 120 s lease, which holds the sweep back and lets pg-boss expire first.")
      } else {
        console.log(`      sawLeaveActive=${sawLeaveActive}, and no attempt-1 row of any kind exists for the`)
        console.log('      killed task. reconcile.mjs only writes for a task whose queue row shows attempt > 1')
        console.log('      and whose ledger holds no row claiming an earlier attempt; the census above says')
        console.log('      which of the two the run did not reach. Try a longer --recover-ms.')
      }
    }

    head('8. the daemon log after the restart (last 20 lines)')
    for (const line of boot.lines.slice(-20)) console.log(`      ${line}`)

    console.log('')
    console.log(
      `DRILL SUMMARY ${JSON.stringify({
        killedTaskId,
        killMethod: 'SIGKILL/TerminateProcess',
        exit: exitInfo,
        censusA: censusA.length,
        censusB: censusB.length,
        censusC: censusC.length,
        lost: lost.length,
        illegalTransitions: illegal.length,
        reconstructed: reconstructed ? reconstructed.taskId : null,
        failures,
      })}`,
    )
    return failures
  } finally {
    if (boot && boot.child.exitCode === null) {
      boot.child.kill('SIGKILL')
      await awaitExit(boot.child)
    }
    await sql.end().catch(() => {})
    await watcher.end().catch(() => {})
    if (!opts.keep) {
      // The drill DATABASE is left as it is on purpose: it is the evidence. Only the
      // scratch config/data/ledger tree goes, and --keep holds even that.
      info(`drill root kept at ${opts.root} for inspection (pass --keep to keep it after a future run too)`)
    }
    info('the PostgreSQL cluster is LEFT RUNNING — this drill never starts or stops one')
  }
}

main()
  .then((code) => {
    console.log(code === 0 ? 'RESULT: GREEN (exit 0)' : `RESULT: RED (${code} failing checks)`)
    process.exit(code === 0 ? 0 : code === 2 ? 2 : 1)
  })
  .catch((err) => {
    console.error('DRILL CRASHED:', err && err.stack ? err.stack : err)
    process.exit(1)
  })
