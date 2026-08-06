/**
 * queue-utf8-migrate.mjs — move the task queue onto a UTF-8 database, so a task can be
 * named in the language the person actually works in.
 *
 * WHY THIS FILE EXISTS. PostgreSQL fixes a database's encoding at CREATE time and no ALTER
 * can change it. A cluster initialised by the Windows `initdb` defaults to the machine's
 * ANSI code page (WIN1252 on a Western install), and a queue database created there refuses
 * every title that is not plain ASCII — Cyrillic, Greek, Japanese, an emoji. The daemon now
 * says so at boot; this is the door out that its message points at.
 *
 * WHAT IT DOES, IN THE ORDER IT MATTERS
 *   1. asks the database what encoding it is — a UTF-8 one is left alone;
 *   2. refuses while anything else is connected (stop the daemon first): the rename at the
 *      end cannot run against a database in use, and a half-done swap is the one outcome
 *      that is hard to undo in a hurry;
 *   3. writes the whole export to a JSON file BEFORE any DDL, so the work exists outside the
 *      database from that moment on;
 *   4. creates a new database in UTF8 over `template0`, carries the tasks that are still
 *      waiting and the daemon's own attempt rows into it;
 *   5. renames the old database out of the way — KEEPS it, never drops it — and puts the new
 *      one in its place. If that last rename fails the old name is restored.
 *
 * DRY RUN BY DEFAULT. With no `--apply` it reads, counts and prints — including the list of
 * what a migration would NOT carry. Nothing is created and nothing is renamed.
 *
 * USAGE
 *   node supervisor/queue-utf8-migrate.mjs [--apply] [options]
 *
 *   --apply           actually migrate (without it: report only)
 *   --url <conn>      queue connection string (default: queueUrl from ~/.sma-daemon/config.json)
 *   --admin-db <name> the database the two DDL statements run against (default postgres)
 *   --out <file>      where the export is written (default ~/.sma-daemon/queue-migration-<stamp>.json)
 *   --quiet           the summary line only
 *
 * EXIT CODES: 0 migrated or nothing to do, 3 refused (in use / unknown encoding),
 * 4 the migration failed and said why, 1 unexpected error.
 *
 * Node built-ins, plus the `pg` client the daemon already depends on and the product's own
 * queue backend — the new database is filled through the SAME adapter the daemon uses, so
 * its schema, its queues and its validation are by construction the ones the daemon expects.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { migrateQueueEncoding, readQueueEncoding, UTF8 } from '../daemon/src/queue/encoding.mjs'
import { createPgBossQueue } from '../daemon/src/queue/pgboss-backend.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SETUP_DOC = 'supervisor/setup-windows.md'

let QUIET = false
const say = (msg) => {
  if (!QUIET) console.log(msg)
}
const step = (msg) => say(`  ..  ${msg}`)
const done = (msg) => say(`ok    ${msg}`)
const warn = (msg) => console.log(`warn  ${msg}`)
const bad = (msg) => console.error(`ERROR ${msg}`)

/** The `pg` client, from either place the product keeps it (checkout root or daemon/). */
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

/**
 * daemonQueueUrl() — the connection string from the daemon config, READ rather than loaded:
 * loading it through the daemon's own loader would CREATE a config on a machine that has
 * none, and a migration tool has no business minting the daemon's identity.
 */
export function daemonQueueUrl(configPath = join(homedir(), '.sma-daemon', 'config.json')) {
  try {
    if (!existsSync(configPath)) return null
    const raw = JSON.parse(readFileSync(configPath, 'utf8'))
    return raw && typeof raw.queueUrl === 'string' && raw.queueUrl.trim() ? raw.queueUrl : null
  } catch {
    return null
  }
}

/** The same connection string pointed at another database on the same server. */
export function urlForDatabase(queueUrl, database) {
  const url = new URL(queueUrl)
  url.pathname = `/${database}`
  return url.toString()
}

/** The database named by a connection string. */
export function databaseOf(queueUrl) {
  const name = new URL(queueUrl).pathname.replace(/^\//, '')
  if (!name) throw new Error(`the connection string names no database: ${new URL(queueUrl).pathname}`)
  return name
}

/**
 * A one-shot SQL executor over a single client. `client_encoding` is asked for explicitly:
 * without it the session runs on whatever the cluster's configuration decides, while
 * node-postgres decodes the bytes as UTF-8 either way — which is precisely how text stored
 * in WIN1252 could arrive mangled and be written mangled into the new database.
 */
function makeExecSql(pg, connectionString) {
  return async (sql, params = []) => {
    const client = new pg.Client({ connectionString, client_encoding: UTF8 })
    await client.connect()
    try {
      return await client.query(sql, params)
    } finally {
      await client.end()
    }
  }
}

async function run(opts) {
  const queueUrl = opts.url ?? daemonQueueUrl()
  if (!queueUrl) {
    bad('no queue connection string: pass --url, or set "queueUrl" in ~/.sma-daemon/config.json')
    return 1
  }
  const database = databaseOf(queueUrl)
  const pg = await loadPg()
  const sourceSql = makeExecSql(pg, queueUrl)
  const adminSql = makeExecSql(pg, urlForDatabase(queueUrl, opts.adminDb))

  const current = await readQueueEncoding(sourceSql)
  say(`queue database: ${database}  (encoding ${current?.serverEncoding ?? 'unknown'})`)

  const report = await migrateQueueEncoding({
    database,
    sourceSql,
    adminSql,
    // The new database is filled through the daemon's OWN adapter: it provisions the lane
    // queues and the approval table exactly as a boot would, and it validates every task it
    // takes. Nothing here re-implements the queue's schema.
    openTarget: async (targetDatabase) => {
      const targetUrl = urlForDatabase(queueUrl, targetDatabase)
      const adapter = createPgBossQueue({ queueUrl: targetUrl, log: step })
      await adapter.start()
      return {
        enqueue: (task) => adapter.enqueue(task),
        execSql: (sql, params) => adapter.execSql(sql, params),
        stop: () => adapter.stop(),
      }
    },
    snapshot: async (payload) => {
      const file = opts.out ?? join(homedir(), '.sma-daemon', `queue-migration-${payload.stamp}.json`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
      done(`export written: ${file}`)
      return file
    },
    apply: opts.apply,
    log: step,
  })

  if (report.reason === 'already_utf8') {
    done(`${database} is already ${UTF8} — nothing to do`)
    return 0
  }
  if (report.reason === 'unknown_encoding') {
    bad(`could not read the encoding of ${database} — is it reachable, and may this role read pg_database?`)
    return 3
  }
  if (report.reason === 'in_use') {
    bad(`${report.otherConnections} other connection(s) are using ${database}.`)
    console.error('      Stop the daemon (and any psql session) and run this again — the swap at the')
    console.error('      end cannot rename a database that is in use.')
    return 3
  }

  say('')
  say(`waiting tasks: ${report.pending}    attempt rows: ${report.approvals}`)
  say('what a migration does NOT carry:')
  for (const line of report.notCarried) say(`  - ${line}`)
  say('')

  if (!report.applied) {
    warn(`this was a report, nothing changed. To do it: ${'node supervisor/queue-utf8-migrate.mjs --apply'}`)
    say(`MIGRATION ${JSON.stringify({ database, encoding: report.encoding, applied: false, pending: report.pending })}`)
    return 0
  }

  done(`${database} is now ${UTF8}: ${report.carried.tasks} task(s) and ${report.carried.approvals} attempt row(s) carried`)
  done(`the previous database is KEPT as ${report.archivedAs} — delete it yourself once you are satisfied`)
  say('')
  say(`MIGRATION ${JSON.stringify({ database, applied: true, carried: report.carried, archivedAs: report.archivedAs })}`)
  say('next:   start the daemon again')
  return 0
}

/** parseArgs(argv) → the option object. Explicit-pick: an unknown flag is refused, not ignored. */
export function parseArgs(argv) {
  const opts = { apply: false, url: null, adminDb: 'postgres', out: null, help: false }
  const rest = [...argv]
  while (rest.length) {
    const flag = rest.shift()
    const value = () => {
      const v = rest.shift()
      if (v === undefined) throw new Error(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case '--apply': opts.apply = true; break
      case '--url': opts.url = value(); break
      case '--admin-db': opts.adminDb = value(); break
      case '--out': opts.out = value(); break
      case '--quiet': QUIET = true; break
      case '--help': case '-h': opts.help = true; break
      default: throw new Error(`unknown option "${flag}" (try --help)`)
    }
  }
  return opts
}

const USAGE = `
node supervisor/queue-utf8-migrate.mjs [--apply] [options]

  Move the task queue onto a UTF-8 database, so a task can be named in any language.
  Without --apply it only reports: the encoding, what is waiting, and what a migration
  would not carry. The old database is renamed and KEPT, never dropped.

  --apply            actually migrate (stop the daemon first)
  --url <conn>       queue connection string (default: ~/.sma-daemon/config.json queueUrl)
  --admin-db <name>  database the two DDL statements run against (default postgres)
  --out <file>       where the export is written before any change
  --quiet            summary line only
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
  run(opts)
    .then((code) => process.exit(code))
    .catch((err) => {
      // A migration that failed says what it did and what it did not: the module puts the
      // original database back under its own name before it throws.
      bad(String((err && err.message) || err))
      if (err && err.cause) console.error(`      cause: ${String((err.cause && err.cause.message) || err.cause)}`)
      process.exit(4)
    })
}
