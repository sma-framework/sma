/**
 * pgboss-real-stats-keys.ts — WHAT THE REAL QUEUE DATABASE ACTUALLY ANSWERS ABOUT A QUEUE.
 *
 * NOT a fixture in the usual sense: nothing here is written by us. Both readers below pull
 * from the INSTALLED pg-boss package, so a test built on them fails the day the library
 * renames a column — which is the entire point. A hand-written list of key names would be a
 * second copy of the belief under test, and this product has already paid for one of those
 * (the fake with a `touch()` the library never had; see pgboss-contract.test.ts).
 *
 * WHY NOT A LIVE POSTGRES. There is none in this suite, and adding one would put a gate
 * behind a service that is absent on most machines — a test that skips is a test that stops
 * guarding. `statsRowKeys()` reads the statement pg-boss SENDS to the database and takes its
 * column aliases: those aliases ARE the keys of the row the real database hands back, because
 * the row is built by that SELECT and by nothing else. It is the library's own SQL, not our
 * reading of its documentation.
 *
 * It lives in `fixtures/` (not `*.test.ts`) so vitest's include pattern never collects it and
 * both test files that need it can import it without re-running each other's describes.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** pg-boss's own SQL builders — the module `manager.js` calls to talk to the database. */
function plans(): any {
  return require('pg-boss/src/plans.js')
}

/**
 * The column names of the row `getQueueStats` reads out of the queue database, taken from the
 * statement itself. `name` is selected bare; the counts are all aliased.
 */
export function statsRowKeys(): string[] {
  const sql: string = plans().getQueueStats('pgboss', 'j_sma_task_prod', ['sma.task.prod'])
  const aliased = [...sql.matchAll(/\bas\s+"([A-Za-z0-9_]+)"/g)].map((m) => m[1])
  // A regex that matched nothing would make every caller pass by vacancy.
  if (aliased.length === 0) throw new Error('pg-boss getQueueStats plan has no aliased columns — reader is stale')
  return [...new Set(['name', ...aliased])]
}

/** The same, for the cached queue row `getQueueStats` merges its counts onto. */
export function queueRowKeys(): string[] {
  const sql: string = plans().getQueues('pgboss', ['sma.task.prod'])
  return [...new Set(['name', ...[...sql.matchAll(/\bas\s+"([A-Za-z0-9_]+)"/g)].map((m) => m[1])])]
}

/**
 * The members pg-boss DECLARES on the object `getQueueStats` resolves to (`QueueResult` and
 * the `Queue` it extends), read off the package's shipped `types.d.ts`.
 *
 * A second, independent reading of the same answer: the SQL says what the database returns,
 * the type says what the library promises. A key that is in neither is a key nobody offers.
 */
export function declaredQueueResultKeys(): string[] {
  const pkg = require.resolve('pg-boss/package.json')
  const dts = readFileSync(join(dirname(pkg), 'types.d.ts'), 'utf8')
  const block = (name: string): string => {
    const m = dts.match(new RegExp(`type\\s+${name}\\s*=[^{]*\\{([\\s\\S]*?)\\n\\s*\\}`))
    if (!m) throw new Error(`pg-boss types.d.ts has no ${name} block — reader is stale`)
    return m[1]
  }
  const members = (body: string) => [...body.matchAll(/^\s*([A-Za-z0-9_]+)\??\s*:/gm)].map((m) => m[1])
  const keys = [...members(block('QueueResult')), ...members(block('Queue'))]
  if (keys.length === 0) throw new Error('pg-boss types.d.ts declares no QueueResult members — reader is stale')
  return [...new Set(keys)]
}

/**
 * Everything a caller of `getQueueStats` may find on the answer: the database row, the queue
 * row it is merged onto, and what the types declare. The union is the ceiling for a FAKE — a
 * double may know less than the library, never more.
 */
export function everyKeyTheAnswerMayCarry(): string[] {
  return [...new Set([...statsRowKeys(), ...queueRowKeys(), ...declaredQueueResultKeys()])]
}
