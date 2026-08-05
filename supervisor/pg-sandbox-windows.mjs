/**
 * pg-sandbox-windows.mjs — bring the queue's PostgreSQL up, wait until it really ANSWERS,
 * and create the daemon's database. The missing half of «run a local PostgreSQL».
 *
 * WHY THIS FILE EXISTS. `node daemon/src/main.mjs` refuses to boot without a Postgres, and
 * until now nothing in the product started one: `setup-windows.md` told the reader to
 * assemble a `~/pg-sandbox` by hand and run its `start.mjs`, and on the reference machine
 * that script DID NOT RETURN — it was killed on a timeout and left the cluster in crash
 * recovery, accepting connections it never answered. The cluster came up only through
 * `pg_ctl` directly. This script takes that road, and it makes the two lessons of that
 * afternoon structural rather than folklore:
 *
 *   1. START AND READINESS ARE DIFFERENT QUESTIONS. `pg_ctl` is asked to start the
 *      postmaster and NOT to wait (`-W`); the waiting is done here, by opening a real
 *      connection and running a real query. A listening socket is not readiness — a
 *      postmaster in crash recovery accepts the TCP connection and then refuses the
 *      session with `57P03 the database system is starting up`. Anything that probes the
 *      PORT reports that cluster as up, and the daemon then dies on its first query.
 *   2. THE TRAP IS NAMED, NOT GUESSED AT. `57P03` is reported as what it is — recovery in
 *      progress — and waited out, with the wait bounded. Crash recovery ENDS by itself;
 *      restarting a recovering cluster only makes it recover again, so this script never
 *      does that on its own. If the bound is reached it prints the server log's own last
 *      lines and the one command that clears a genuinely wedged cluster, rather than
 *      thrashing the founder's data directory.
 *
 * IDEMPOTENT BY CONSTRUCTION. `start` probes BEFORE it does anything: a cluster that is
 * already answering is reported as already up, its databases are ensured (a `CREATE
 * DATABASE` that hits `42P04` is a success, not an error), and the exit code is 0. Running
 * it twice, or while someone else's daemon is using the same cluster, changes nothing.
 *
 * WHAT IT IS NOT. It is not a Postgres installer. When `~/pg-sandbox` is absent it says so
 * in one readable sentence, names the two things to create, and points at
 * `supervisor/setup-windows.md` — the document that owns that procedure.
 *
 * USAGE
 *   node supervisor/pg-sandbox-windows.mjs [start|stop|status] [options]
 *
 *   --port <n>       queue port                      (default 5433)
 *   --sandbox <dir>  the sandbox directory           (default ~/pg-sandbox)
 *   --db <name>      database to ensure, repeatable  (default: from the daemon config's
 *                                                     queueUrl, else sma_queue)
 *   --user <name> / --password <s>                   (default postgres/postgres)
 *   --timeout <ms>   readiness bound                 (default 90000)
 *   --quiet          only the summary line
 *
 * EXIT CODES: 0 ready (or already ready / already stopped), 2 sandbox missing,
 * 3 start failed or readiness not reached, 1 unexpected error.
 *
 * Node built-ins, plus `pg` for the readiness query and the CREATE DATABASE — the same
 * client the daemon's own queue backend uses, resolved from the product's own tree.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

/** The document that owns the «assemble a sandbox» procedure — quoted in every refusal. */
const SETUP_DOC = 'supervisor/setup-windows.md'

/** Postgres SQLSTATEs this script reads by name rather than by message text. */
const SQLSTATE = Object.freeze({
  STARTING_UP: '57P03', // the postmaster accepts, the cluster is still in recovery
  DUPLICATE_DATABASE: '42P04', // CREATE DATABASE on one that exists — a success here
})

// ── output ────────────────────────────────────────────────────────────────────────────

let QUIET = false
const say = (msg) => {
  if (!QUIET) console.log(msg)
}
const step = (msg) => say(`  ..  ${msg}`)
const done = (msg) => say(`ok    ${msg}`)
const warn = (msg) => console.log(`warn  ${msg}`)
const bad = (msg) => console.error(`ERROR ${msg}`)

// ── the sandbox layout ────────────────────────────────────────────────────────────────

/**
 * locateSandbox(dir) → {pgCtl, pgData, logFile} or a `missing` verdict naming what to make.
 *
 * The embedded-postgres binaries live under a PLATFORM package
 * (`@embedded-postgres/windows-x64` on this machine), so the platform directory is
 * discovered rather than hard-coded: the same sandbox shape assembled on another platform
 * resolves without editing this file.
 *
 * @param {string} dir
 * @returns {{ok:true, pgCtl:string, pgData:string, logFile:string}|{ok:false, missing:string[]}}
 */
export function locateSandbox(dir) {
  const missing = []
  const pgData = join(dir, 'pgdata')
  const embeddedRoot = join(dir, 'node_modules', '@embedded-postgres')
  let pgCtl = null
  try {
    for (const platform of readdirSync(embeddedRoot)) {
      for (const name of ['pg_ctl.exe', 'pg_ctl']) {
        const candidate = join(embeddedRoot, platform, 'native', 'bin', name)
        if (existsSync(candidate)) {
          pgCtl = candidate
          break
        }
      }
      if (pgCtl) break
    }
  } catch {
    /* no @embedded-postgres tree at all — reported as the missing binaries below */
  }
  if (!pgCtl) missing.push(`the embedded-postgres binaries (${join(dir, 'node_modules', '@embedded-postgres')})`)
  if (!existsSync(pgData)) missing.push(`an initialised data directory (${pgData})`)
  if (missing.length) return { ok: false, missing }
  return { ok: true, pgCtl, pgData, logFile: join(dir, 'pgctl.log') }
}

/** The refusal a machine with no sandbox gets: what is absent, what to do, where it is written. */
function refuseNoSandbox(dir, missing) {
  bad(`no PostgreSQL sandbox at ${dir}.`)
  for (const m of missing) console.error(`      absent: ${m}`)
  console.error('')
  console.error('      The task queue needs a PostgreSQL. Either point "queueUrl" in')
  console.error('      ~/.sma-daemon/config.json at a server you already run, or create the')
  console.error('      sandbox this script drives:')
  console.error('')
  console.error(`        mkdir ${dir}`)
  console.error(`        cd ${dir}`)
  console.error('        npm init -y && npm install embedded-postgres')
  console.error('        node -e "import(\'embedded-postgres\').then(async ({default:P})=>{')
  console.error("          const pg=new P({databaseDir:'./pgdata',user:'postgres',password:'postgres',port:5433,persistent:true});")
  console.error('          await pg.initialise()})"')
  console.error('')
  console.error(`      The full procedure, with what it costs and what it does not need: ${SETUP_DOC}`)
}

// ── the postgres client, resolved out of the product's own tree ────────────────────────

/**
 * loadPg() — the `pg` client the daemon already depends on.
 *
 * It is looked for in BOTH places the product keeps it: the repository's own
 * `node_modules` (a git checkout) and `daemon/node_modules` (the published package, which
 * vendors `pg`/`pg-boss` under the daemon rather than at the root). A checkout that has
 * neither gets the install line, not a stack trace.
 */
async function loadPg() {
  const require = createRequire(import.meta.url)
  let resolved
  try {
    resolved = require.resolve('pg', { paths: [HERE, REPO, join(REPO, 'daemon')] })
  } catch {
    throw new Error(
      `the "pg" client is not installed in this checkout. Install the daemon's two runtime ` +
        `dependencies first:  npm install --no-save pg-boss@11 pg   (see ${SETUP_DOC})`,
    )
  }
  const mod = await import(pathToFileURL(resolved).href)
  return mod.default ?? mod
}

// ── probes ────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Is anything listening on the port? A true here is NOT readiness — see the header. */
function probePort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* closing a socket we are done with never matters */
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

/**
 * probeSql(pg, url) → {state}. THE readiness question: not «is the port open» but «does a
 * session open and a query return».
 *
 *   ready       a connection was made and `select 1` answered
 *   recovering  the postmaster answered `57P03` — the cluster is still replaying WAL
 *   down        nothing accepted the connection
 *   error       something else, carried verbatim so it can be read
 */
async function probeSql(pg, url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 })
  try {
    await client.connect()
    await client.query('select 1')
    return { state: 'ready' }
  } catch (err) {
    const code = err && err.code
    if (code === SQLSTATE.STARTING_UP) return { state: 'recovering', detail: String(err.message || err) }
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET'].includes(code)) {
      return { state: 'down', detail: code }
    }
    return { state: 'error', detail: String((err && err.message) || err) }
  } finally {
    try {
      await client.end()
    } catch {
      /* a client that never connected has nothing to end */
    }
  }
}

/**
 * waitUntilReady(pg, url, deadline, onState) — poll `probeSql` until it answers `ready`.
 *
 * Every distinct state is announced ONCE, so a wait that is really crash recovery reads as
 * crash recovery in the transcript instead of as a hang.
 */
async function waitUntilReady(pg, url, deadline, onState) {
  let last = null
  for (;;) {
    const probe = await probeSql(pg, url)
    if (probe.state !== last) {
      last = probe.state
      onState(probe)
    }
    if (probe.state === 'ready') return probe
    if (Date.now() >= deadline) return probe
    await sleep(500)
  }
}

// ── the databases ─────────────────────────────────────────────────────────────────────

/**
 * ensureDatabases(pg, adminUrl, names) — create each database that is not there yet.
 *
 * UTF8 EXPLICITLY, over `template0`. Windows `initdb` defaults a cluster to the ANSI code
 * page, and a queue database in WIN1252 cannot hold a task title written in Cyrillic — the
 * kind of fault that surfaces months later as one unreadable row. When the cluster refuses
 * that combination the plain `CREATE DATABASE` is tried instead and the encoding actually
 * obtained is reported, so a compromise is visible rather than silent.
 *
 * @returns {Promise<Array<{name:string, created:boolean, encoding:string|null}>>}
 */
async function ensureDatabases(pg, adminUrl, names) {
  const out = []
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    for (const name of names) {
      let created = false
      try {
        await client.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`)
        created = true
      } catch (err) {
        if (err && err.code === SQLSTATE.DUPLICATE_DATABASE) {
          created = false
        } else {
          // The cluster refused the explicit form (an unsupported locale, most often).
          // Fall back to its own defaults rather than leaving the daemon without a database.
          try {
            await client.query(`CREATE DATABASE "${name}"`)
            created = true
            warn(`${name}: created with the cluster's default encoding — explicit UTF8 was refused (${String(err.message || err)})`)
          } catch (err2) {
            if (err2 && err2.code === SQLSTATE.DUPLICATE_DATABASE) created = false
            else throw err2
          }
        }
      }
      const enc = await client.query('select pg_encoding_to_char(encoding) as enc from pg_database where datname = $1', [name])
      out.push({ name, created, encoding: (enc.rows[0] && enc.rows[0].enc) || null })
    }
  } finally {
    await client.end()
  }
  return out
}

/**
 * daemonQueueDatabase() → the database name in the daemon config's `queueUrl`, or null.
 *
 * The config file is READ, never loaded through `loadConfig()`: loading it would CREATE a
 * config on a machine that has none, and a script whose job is to start a database has no
 * business minting the daemon's identity as a side effect.
 */
export function daemonQueueDatabase(configPath = join(homedir(), '.sma-daemon', 'config.json')) {
  try {
    if (!existsSync(configPath)) return null
    const raw = JSON.parse(readFileSync(configPath, 'utf8'))
    if (!raw || typeof raw.queueUrl !== 'string') return null
    const name = new URL(raw.queueUrl).pathname.replace(/^\//, '')
    return name && name !== 'postgres' ? name : null
  } catch {
    return null // an unreadable or half-written config falls back to the documented default
  }
}

// ── pg_ctl ────────────────────────────────────────────────────────────────────────────

/**
 * pgCtl(bin, args) → {code, stdout, stderr}. Never a shell: an args array, like every other
 * child this product starts.
 */
function pgCtl(bin, args) {
  const res = spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' }
}

/** `pg_ctl status` → 'running' | 'stopped' | 'unknown' (exit 0 / 3 / anything else). */
function clusterStatus(pgCtlBin, pgData) {
  const res = pgCtl(pgCtlBin, ['-D', pgData, 'status'])
  if (res.code === 0) return 'running'
  if (res.code === 3) return 'stopped'
  return 'unknown'
}

/** The tail of the server log — the only place a refused start explains itself. */
function tailLog(logFile, lines = 12) {
  try {
    const text = readFileSync(logFile, 'utf8')
    return text.split(/\r?\n/).filter(Boolean).slice(-lines)
  } catch {
    return []
  }
}

// ── commands ──────────────────────────────────────────────────────────────────────────

async function cmdStart(opts) {
  const found = locateSandbox(opts.sandbox)
  if (!found.ok) {
    refuseNoSandbox(opts.sandbox, found.missing)
    return 2
  }
  const pg = await loadPg()
  const adminUrl = `postgres://${opts.user}:${opts.password}@127.0.0.1:${opts.port}/postgres`
  const deadline = Date.now() + opts.timeout

  // (1) ALREADY UP? asked first, and asked with a query rather than with a port probe.
  const first = await probeSql(pg, adminUrl)
  let started = false
  if (first.state === 'ready') {
    step(`:${opts.port} is already up and answering — nothing to start`)
  } else if (first.state === 'recovering') {
    // The recorded trap. It is named here and waited out; see the file header for why this
    // script does not restart a recovering cluster.
    warn(`:${opts.port} accepts connections but is still in crash recovery (${SQLSTATE.STARTING_UP}) — waiting for it to finish`)
  } else {
    const status = clusterStatus(found.pgCtl, found.pgData)
    if (status === 'running') {
      warn(`pg_ctl says a server is running on ${found.pgData}, but :${opts.port} refused the connection (${first.detail ?? first.state}).`)
      warn(`      That is a stale postmaster.pid or a server on another port. Clear it with:`)
      warn(`      "${found.pgCtl}" -D "${found.pgData}" -m immediate stop`)
      return 3
    }
    step(`starting the cluster: pg_ctl -D "${found.pgData}" -l "${found.logFile}" -o "-p ${opts.port}" start`)
    // -W: pg_ctl is asked to START, not to WAIT. Its own wait is what hung on the reference
    // machine; the readiness loop below is this script's answer and it can be reasoned about.
    const res = pgCtl(found.pgCtl, ['-D', found.pgData, '-l', found.logFile, '-o', `-p ${opts.port}`, '-W', 'start'])
    if (res.code !== 0) {
      bad(`pg_ctl start exited ${res.code}`)
      for (const line of (res.stderr || res.stdout || '').split(/\r?\n/).filter(Boolean)) console.error(`      ${line}`)
      for (const line of tailLog(found.logFile)) console.error(`      log: ${line}`)
      return 3
    }
    started = true
  }

  // (2) READINESS — a session that opens and a query that answers, never a listening socket.
  const ready = await waitUntilReady(pg, adminUrl, deadline, (p) => {
    if (p.state === 'recovering') step(`still replaying WAL (${SQLSTATE.STARTING_UP}) — this ends by itself`)
    else if (p.state === 'down') step('waiting for the postmaster to accept connections')
    else if (p.state === 'error') step(`probe says: ${p.detail}`)
  })
  if (ready.state !== 'ready') {
    bad(`:${opts.port} did not become ready within ${opts.timeout} ms (last state: ${ready.state}${ready.detail ? ` — ${ready.detail}` : ''}).`)
    for (const line of tailLog(found.logFile)) console.error(`      log: ${line}`)
    console.error('')
    console.error('      A cluster stuck in recovery clears with a hard stop and a fresh start:')
    console.error(`        "${found.pgCtl}" -D "${found.pgData}" -m immediate stop`)
    console.error(`        node supervisor/pg-sandbox-windows.mjs start --port ${opts.port}`)
    return 3
  }
  done(`PostgreSQL is ready on 127.0.0.1:${opts.port}${started ? ' (started by this run)' : ' (was already up)'}`)

  // (3) THE DAEMON'S DATABASE — the half «run a local PostgreSQL» always left out.
  const dbs = await ensureDatabases(pg, adminUrl, opts.databases)
  for (const db of dbs) {
    done(`database ${db.name}: ${db.created ? 'created' : 'already there'} (encoding ${db.encoding ?? 'unknown'})`)
  }

  say('')
  say(`SANDBOX ${JSON.stringify({ port: opts.port, started, databases: dbs, dataDir: found.pgData, log: found.logFile })}`)
  say(`next:   node daemon/src/main.mjs        (stop the cluster with: ${'node supervisor/pg-sandbox-windows.mjs stop'})`)
  return 0
}

async function cmdStop(opts) {
  const found = locateSandbox(opts.sandbox)
  if (!found.ok) {
    refuseNoSandbox(opts.sandbox, found.missing)
    return 2
  }
  if (clusterStatus(found.pgCtl, found.pgData) === 'stopped') {
    done('the cluster is already stopped — nothing to do')
    return 0
  }
  step(`stopping: pg_ctl -D "${found.pgData}" -m fast stop`)
  const res = pgCtl(found.pgCtl, ['-D', found.pgData, '-m', 'fast', 'stop'])
  if (res.code !== 0) {
    bad(`pg_ctl stop exited ${res.code}`)
    for (const line of (res.stderr || res.stdout || '').split(/\r?\n/).filter(Boolean)) console.error(`      ${line}`)
    return 3
  }
  const deadline = Date.now() + opts.timeout
  while (Date.now() < deadline) {
    if (!(await probePort(opts.port))) {
      done(`PostgreSQL on 127.0.0.1:${opts.port} is stopped`)
      return 0
    }
    await sleep(300)
  }
  warn(`pg_ctl reported a clean stop but :${opts.port} still accepts connections — another server may own that port`)
  return 0
}

async function cmdStatus(opts) {
  const found = locateSandbox(opts.sandbox)
  if (!found.ok) {
    refuseNoSandbox(opts.sandbox, found.missing)
    return 2
  }
  const pg = await loadPg()
  const adminUrl = `postgres://${opts.user}:${opts.password}@127.0.0.1:${opts.port}/postgres`
  const ctl = clusterStatus(found.pgCtl, found.pgData)
  const port = await probePort(opts.port)
  const sql = await probeSql(pg, adminUrl)
  say(`pg_ctl:   ${ctl}`)
  say(`port:     ${port ? 'open' : 'closed'} (127.0.0.1:${opts.port})`)
  say(`session:  ${sql.state}${sql.detail ? ` — ${sql.detail}` : ''}`)
  if (sql.state === 'ready') {
    const client = new pg.Client({ connectionString: adminUrl })
    await client.connect()
    try {
      const r = await client.query(
        'select datname, pg_encoding_to_char(encoding) as enc from pg_database where datistemplate = false order by datname',
      )
      say(`databases: ${r.rows.map((d) => `${d.datname}(${d.enc})`).join(', ')}`)
    } finally {
      await client.end()
    }
  }
  say('')
  say(`STATUS ${JSON.stringify({ pgCtl: ctl, port: port ? 'open' : 'closed', session: sql.state })}`)
  return sql.state === 'ready' ? 0 : 3
}

// ── argv ──────────────────────────────────────────────────────────────────────────────

/** parseArgs(argv) → the option object. Explicit-pick: an unknown flag is refused, not ignored. */
export function parseArgs(argv) {
  const opts = {
    command: 'start',
    port: 5433,
    sandbox: join(homedir(), 'pg-sandbox'),
    user: 'postgres',
    password: 'postgres',
    timeout: 90000,
    databases: [],
    help: false,
  }
  const rest = [...argv]
  if (rest[0] && !rest[0].startsWith('-')) opts.command = rest.shift()
  while (rest.length) {
    const flag = rest.shift()
    const value = () => {
      const v = rest.shift()
      if (v === undefined) throw new Error(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case '--port': opts.port = Number(value()); break
      case '--sandbox': opts.sandbox = value(); break
      case '--db': opts.databases.push(value()); break
      case '--user': opts.user = value(); break
      case '--password': opts.password = value(); break
      case '--timeout': opts.timeout = Number(value()); break
      case '--quiet': QUIET = true; break
      case '--help': case '-h': opts.help = true; break
      default: throw new Error(`unknown option "${flag}" (try --help)`)
    }
  }
  if (!['start', 'stop', 'status'].includes(opts.command)) throw new Error(`unknown command "${opts.command}" (start|stop|status)`)
  if (!Number.isFinite(opts.port) || opts.port <= 0) throw new Error('--port must be a port number')
  if (opts.databases.length === 0) opts.databases = [daemonQueueDatabase() ?? 'sma_queue']
  return opts
}

const USAGE = `
node supervisor/pg-sandbox-windows.mjs [start|stop|status] [options]

  start    bring the sandbox cluster up, wait until a session really answers, and create
           the daemon's database if it is missing. Safe to run when it is already up.
  stop     pg_ctl -m fast stop.
  status   what pg_ctl, the port and a real session each say.

  --port <n>        queue port (default 5433)
  --sandbox <dir>   sandbox directory (default ~/pg-sandbox)
  --db <name>       database to ensure, repeatable
                    (default: the database in ~/.sma-daemon/config.json's queueUrl, else sma_queue)
  --user / --password   (default postgres/postgres)
  --timeout <ms>    readiness bound (default 90000)
  --quiet           summary line only
`

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    bad(String((err && err.message) || err))
    process.exit(1)
  }
  if (opts.help) {
    console.log(USAGE.trim())
    process.exit(0)
  }
  const run = opts.command === 'stop' ? cmdStop : opts.command === 'status' ? cmdStatus : cmdStart
  run(opts)
    .then((code) => process.exit(code))
    .catch((err) => {
      bad(String((err && err.stack) || err))
      process.exit(1)
    })
}
