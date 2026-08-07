/**
 * stop() closes the pool it opened.
 *
 * The backend talks to Postgres through two doors, not one. pg-boss owns the queue's own
 * connections; a LAZY `pg.Pool` behind the default `execSql` serves everything the library
 * cannot answer — list/resolve, the approval table, the encoding probe. `stop()` used to
 * shut down only the first of the two.
 *
 * What that cost was not an idle socket. A caller that awaits stop() believes it has let the
 * database go, and the encoding migration is exactly such a caller: it fills a NEW database
 * through this adapter, stops it, then renames it into place. Postgres refuses to rename a
 * database while any connection to it remains, so the migration hit its rollback branch on
 * every run — «is being accessed by other users» — and a queue created with the wrong
 * encoding could never be moved off it. Measured on a live sandbox with an EMPTY queue, so
 * no amount of data made it more or less likely: the leak alone was enough.
 *
 * Why the suite never saw it: every other test injects `execSql`, so the real pool is never
 * opened and the leaking branch is never entered. The fake was, once again, cheaper than the
 * thing it models. These cases enter that branch on purpose, with the driver itself faked —
 * no Postgres is started and `pg` is never really loaded.
 */

import { describe, it, expect, vi } from 'vitest'

// Recorders live in a hoisted block: `vi.mock` factories are lifted above the imports, so a
// plain `const` declared here would not exist yet when the factory runs.
const { pools } = vi.hoisted(() => ({
  pools: [] as Array<{ queries: number; ended: number }>,
}))

vi.mock('pg', () => {
  class FakePool {
    rec: { queries: number; ended: number }

    constructor(_opts: unknown) {
      this.rec = { queries: 0, ended: 0 }
      pools.push(this.rec)
    }

    async query(_sql: string, _params?: unknown[]) {
      this.rec.queries += 1
      return { rows: [] }
    }

    async end() {
      this.rec.ended += 1
    }
  }
  return { default: { Pool: FakePool } }
})

import { createPgBossQueue } from '../src/queue/pgboss-backend.mjs'

const QUEUE_URL = 'postgres://postgres:postgres@localhost:5433/sma_queue_under_test'

describe('pgboss backend — the lazy pool follows the adapter lifecycle', () => {
  it('opens no pool until execSql is actually used', async () => {
    pools.length = 0
    const adapter = createPgBossQueue({ queueUrl: QUEUE_URL })

    expect(pools).toHaveLength(0)

    await adapter.execSql('select 1', [])
    expect(pools).toHaveLength(1)
  })

  it('stop() ends the pool it opened', async () => {
    pools.length = 0
    const adapter = createPgBossQueue({ queueUrl: QUEUE_URL })
    await adapter.execSql('select 1', [])
    expect(pools[0].ended).toBe(0)

    await adapter.stop()

    // THE REGRESSION, in one line: without this the connection outlives the stop() its
    // caller awaited, and a rename of the database it points at is refused.
    expect(pools[0].ended).toBe(1)
  })

  it('drops the handle, so the adapter still works after a stop', async () => {
    pools.length = 0
    const adapter = createPgBossQueue({ queueUrl: QUEUE_URL })
    await adapter.execSql('select 1', [])
    await adapter.stop()

    await adapter.execSql('select 2', [])

    // A FRESH pool — not an awaited handle on an ended one, which would throw instead.
    expect(pools).toHaveLength(2)
    expect(pools[0].ended).toBe(1)
    expect(pools[1].ended).toBe(0)
  })

  it('a second stop() is a no-op, not a double end()', async () => {
    pools.length = 0
    const adapter = createPgBossQueue({ queueUrl: QUEUE_URL })
    await adapter.execSql('select 1', [])

    await adapter.stop()
    await expect(adapter.stop()).resolves.toBe(true)

    expect(pools[0].ended).toBe(1)
  })

  it('stop() is safe when execSql is injected — the driver is never even imported', async () => {
    pools.length = 0
    const adapter = createPgBossQueue({
      queueUrl: QUEUE_URL,
      execSql: async () => ({ rows: [] }),
    })
    await adapter.execSql('select 1', [])

    await expect(adapter.stop()).resolves.toBe(true)
    expect(pools).toHaveLength(0)
  })
})
