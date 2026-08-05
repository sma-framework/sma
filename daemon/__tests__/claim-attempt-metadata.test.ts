/**
 * claim-attempt-metadata.test.ts — the claim must ask pg-boss for the retry count.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE. `pgboss-backend.test.ts` drives the backend
 * against a stateful fake whose `fetch` hands back `retrycount` on every call. Real pg-boss
 * v11 does not: `fetch(name, {batchSize})` returns exactly `id, name, data, expireInSeconds`,
 * and the retry count arrives only under `includeMetadata: true`. The fake was therefore
 * MORE GENEROUS than the library it models, and the whole suite stayed green while every
 * claim against a live queue reported attempt 1 — wrong attempt numbers on every ledger row
 * the tick wrote, one idempotency key shared by a first attempt and a third, and a
 * reconciliation pass that could never find a gap to fill. It was found by the live crash
 * drill (`tools/live-crash-drill.mjs`), not by the suite.
 *
 * So the fake HERE is deliberately strict: it withholds the retry count unless it is asked
 * for, exactly as the library does. A regression that drops the flag makes this file red on
 * a machine with no Postgres installed.
 */

import { describe, it, expect } from 'vitest'

import { createPgBossQueue } from '../src/queue/pgboss-backend.mjs'

/**
 * A pg-boss v11-faithful `fetch`: the minimal column set by default, the retry count ONLY
 * under `includeMetadata`. Records the options every call was made with.
 */
function makeStrictBoss({ retryCount, queue = 'sma.task.prod' }: { retryCount: number; queue?: string }) {
  const fetchCalls: Array<{ name: string; options: Record<string, unknown> }> = []
  let handedOut = false
  return {
    fetchCalls,
    boss: {
      on() {},
      async createQueue() {},
      async fetch(name: string, options: Record<string, unknown> = {}) {
        fetchCalls.push({ name, options })
        if (name !== queue || handedOut) return []
        handedOut = true
        const min = {
          id: 'job-uuid-1',
          name,
          data: { id: 'T-1', source: 'roster', lane: 'prod', title: 'x' },
          expireInSeconds: 120,
        }
        // The whole point: without the flag the caller never learns the retry count.
        return [options.includeMetadata ? { ...min, retryCount } : min]
      },
    },
  }
}

describe('claimNext asks pg-boss for the metadata that carries the attempt number', () => {
  it('passes includeMetadata to every fetch', async () => {
    const { boss, fetchCalls } = makeStrictBoss({ retryCount: 0 })
    const adapter = createPgBossQueue({ boss, execSql: async () => ({ rows: [] }) })

    await adapter.claimNext('w1', { lanes: ['prod'] })

    expect(fetchCalls.length).toBeGreaterThan(0)
    for (const call of fetchCalls) expect(call.options.includeMetadata).toBe(true)
  })

  it('reports the REAL attempt number of a redelivered job, not 1', async () => {
    // A job pg-boss has already handed out twice: retry_count 2 → this is attempt 3.
    const { boss } = makeStrictBoss({ retryCount: 2 })
    const adapter = createPgBossQueue({ boss, execSql: async () => ({ rows: [] }) })

    const task = await adapter.claimNext('w1', { lanes: ['prod'] })

    expect(task).toBeTruthy()
    expect(task.id).toBe('T-1')
    expect(task.attempt).toBe(3)
  })

  it('still reports attempt 1 for a job that has never been retried', async () => {
    const { boss } = makeStrictBoss({ retryCount: 0 })
    const adapter = createPgBossQueue({ boss, execSql: async () => ({ rows: [] }) })

    const task = await adapter.claimNext('w1', { lanes: ['prod'] })

    expect(task.attempt).toBe(1)
  })
})
