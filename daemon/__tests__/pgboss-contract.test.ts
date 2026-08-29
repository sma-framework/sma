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
 *
 * AND THE SAME QUESTION ABOUT THE ANSWER, not just about the call: a method that exists can
 * still be read in a language it does not speak. The second half of this file holds the key
 * names `stats()` reads off `getQueueStats` against the statement pg-boss actually sends to the
 * queue database — the fault that cost the board its «сделано» and «сорвалось» columns.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { QUEUE_STATS_KEYS, QUEUE_STATS_KEYS_NEVER } from '../src/queue/pgboss-backend.mjs'
import {
  statsRowKeys,
  queueRowKeys,
  declaredQueueResultKeys,
  everyKeyTheAnswerMayCarry,
} from './fixtures/pgboss-real-stats-keys'

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

/**
 * ═══ THE SAME LAW, ONE LEVEL DOWN: A METHOD THAT EXISTS, ASKED IN A LANGUAGE IT ANSWERS ═══
 *
 * `getQueueStats` was on the list above and passed it — the method exists. What the list could
 * not see is that the backend then read SIX KEYS OFF ITS ANSWER that the answer has never
 * carried: `queued`, `created`, `active`, `claimed`, `completed`, `failed`. pg-boss counts
 * `deferredCount`, `queuedCount`, `activeCount`, `totalCount` and nothing else. Every one of
 * those six reads was `undefined ?? 0`, so the board's «сделано» and «сорвалось» were zeros
 * minted out of names nobody offers — and a wrong zero is the one wrong number that looks
 * exactly like a right one: «сегодня ничего не сделали» is a plausible day.
 *
 * These cases are held against the INSTALLED library, never against a list we typed: the
 * column aliases of the statement pg-boss sends to the queue database, and the members it
 * declares on the result. See fixtures/pgboss-real-stats-keys.ts.
 */
describe('the keys stats() reads off the real pg-boss', () => {
  it('every key the backend asks for is one the queue database actually returns', () => {
    const fromDb = statsRowKeys()
    const declared = declaredQueueResultKeys()
    const asked = Object.values(QUEUE_STATS_KEYS)

    // Vacancy check: a broken reader must not make this pass by having nothing to compare.
    expect(asked.length).toBeGreaterThan(2)
    expect(fromDb).toContain('queuedCount')

    const missingFromDb = asked.filter((k) => !fromDb.includes(k))
    expect(missingFromDb, `pg-boss's own getQueueStats statement returns no ${missingFromDb.join(', ')}`).toEqual([])

    const undeclared = asked.filter((k) => !declared.includes(k))
    expect(undeclared, `pg-boss declares no ${undeclared.join(', ')} on QueueResult`).toEqual([])
  })

  it('the six names the backend used to ask for appear in NO answer pg-boss gives', () => {
    const anywhere = everyKeyTheAnswerMayCarry()
    expect(anywhere.length).toBeGreaterThan(4)
    const resurrected = QUEUE_STATS_KEYS_NEVER.filter((k) => anywhere.includes(k))
    // If pg-boss ever grows one of these, this fails and the backend SHOULD be revisited —
    // the same documented-reality-check posture as the renewal case above.
    expect(resurrected, `pg-boss now answers ${resurrected.join(', ')} — revisit stats()`).toEqual([])
  })

  it('pg-boss counts no finished and no broken work, which is why the journal is asked instead', () => {
    const anywhere = everyKeyTheAnswerMayCarry()
    for (const absent of ['completedCount', 'failedCount', 'completed', 'failed']) {
      expect(anywhere, `pg-boss answers ${absent} — stats() could read it instead of the journal`).not.toContain(
        absent,
      )
    }
    // And the map says so by omission rather than by comment: there is no entry to read them
    // with, so no future edit can quietly point one at a name that is not there.
    expect(Object.keys(QUEUE_STATS_KEYS).sort()).toEqual(['claimed', 'queued', 'total'])
  })

  it('the counts survive the merge: the cached queue row carries the same names', () => {
    // getQueueStats merges its fresh row ONTO the cached queue row, and on a queue with no
    // jobs at all the fresh row is absent — so the cached row is the whole answer. If the two
    // spelled the counts differently, an empty queue would read as «нет данных» while a busy
    // one read as a number, and nobody would connect the two.
    const cached = queueRowKeys()
    const missing = Object.values(QUEUE_STATS_KEYS).filter((k) => !cached.includes(k))
    expect(missing, `the cached queue row spells ${missing.join(', ')} differently`).toEqual([])
  })
})
