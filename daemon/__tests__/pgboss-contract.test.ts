/**
 * pgboss-contract.test.ts — DOES THE LIBRARY ACTUALLY HAVE THE METHODS WE CALL?
 *
 * Every other test of the queue backend runs against a stateful FAKE pg-boss, and that is
 * the right call: they test our logic, not a vendor's. But a fake is written from what we
 * BELIEVE the library offers, and on 12.08.2026 that belief was wrong in the most expensive
 * way available. `pgboss-backend.mjs` called `bossInstance.touch(name, id)` to renew a job's
 * lease. pg-boss v11 has no touch — no renew, no heartbeat, no extend, nothing. Every
 * renewal threw TypeError into a discarded promise, so a worker that ran longer than the
 * 120s lease was declared `runtime_offline` while it was still streaming; the queue then
 * handed the task to a second worker, and a third, each burning the subscription window,
 * while the board showed an empty queue and an idle worker. The suite was green throughout —
 * because the fake had a `touch` the real library never did.
 *
 * So this file is the one place where the REAL pg-boss is loaded. It reads the backend's own
 * source, extracts every method invoked on the boss instance, and asserts each one exists.
 * The list is DERIVED, never hand-written: a hand-written list would have happily contained
 * `touch` too. Constructing PgBoss opens no connection (verified), so this stays a unit test
 * with no database.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The backend source with comments stripped — prose about a method is not a call to it. */
function backendCode(): string {
  const path = fileURLToPath(new URL('../src/queue/pgboss-backend.mjs', import.meta.url))
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the pg-boss surface this backend depends on', () => {
  it('every method the backend calls on the boss instance exists on a real pg-boss', async () => {
    const called = [...new Set([...backendCode().matchAll(/bossInstance\.([a-zA-Z]+)\(/g)].map((m) => m[1]))].sort()

    // A regex that matched nothing would make this test pass by vacancy — the exact way a
    // guard stops guarding without anyone noticing.
    expect(called.length).toBeGreaterThan(3)

    const { default: PgBoss } = await import('pg-boss')
    // The constructor validates the string and builds the object; it does not connect.
    const boss = new PgBoss('postgres://user:pass@127.0.0.1:5432/does-not-matter') as unknown as Record<string, unknown>

    const missing = called.filter((m) => typeof boss[m] !== 'function')
    expect(missing, `installed pg-boss does not have: ${missing.join(', ')}`).toEqual([])
  })

  it('the lease is renewed by restamping the job row, since the library offers no renewal call', async () => {
    const code = backendCode()
    // The renewal must go through SQL we own. If someone reintroduces a library-side
    // renewal, the first assertion above will catch a non-existent method — this one keeps
    // the intended mechanism visible and named.
    expect(code).toMatch(/UPDATE pgboss\.job SET started_on = now\(\)/)

    const { default: PgBoss } = await import('pg-boss')
    const boss = new PgBoss('postgres://user:pass@127.0.0.1:5432/does-not-matter') as unknown as Record<string, unknown>
    for (const name of ['touch', 'renew', 'heartbeat', 'extend', 'keepAlive']) {
      // Documented reality check: if a future pg-boss grows one of these, this test fails
      // and the backend SHOULD be revisited to use it instead of our UPDATE.
      expect(typeof boss[name], `pg-boss now offers ${name}() — reconsider the manual restamp`).not.toBe('function')
    }
  })
})
