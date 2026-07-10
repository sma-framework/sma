/**
 * Tests for scripts/sma/lib/spend.mjs (Phase 9.2 Plan 09, Task 2).
 *
 * The spend book, the rolling window budget, and the `--stat` scorer contract:
 *   - Test 1 (buildBook): aggregates by session / model / day / agent(main vs sidechain)
 *     over a fixture logs dir; two builds are deep-equal (determinism).
 *   - Test 2 (windowSpend): sums ONLY events inside the rolling window; boundary event
 *     included; empty window → {usd:0, events:0}.
 *   - Test 3 (incremental cache): the second build parses ONLY appended bytes (injected
 *     read-counter); an untouched file is not re-read; a shrunk/replaced file reparses.
 *   - Test 4 (budget): missing/corrupt → the safe default; capUsd null = report-only;
 *     writeBudget persists with {by, at} provenance.
 *   - Test 5 (spendStats): parse-coverage over 99 recognized + 1 unrecognized → 99.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildBook,
  windowSpend,
  readBudget,
  writeBudget,
  spendStats,
  DEFAULT_BUDGET,
} from '../lib/spend.mjs'

/** A v1 assistant transcript line with controllable ts / session / model / sidechain. */
function line(over = {}) {
  const {
    ts = '2026-07-08T12:00:00.000Z',
    sessionId = 'sess-A',
    id = `msg-${Math.random().toString(36).slice(2)}`,
    requestId = `req-${Math.random().toString(36).slice(2)}`,
    model = 'claude-opus-4-8',
    isSidechain = false,
    input = 1000,
    output = 500,
    cacheCreation = 0,
    cacheRead = 0,
    costUSD,
  } = over
  const obj = {
    type: 'assistant',
    timestamp: ts,
    sessionId,
    requestId,
    isSidechain,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
      },
    },
  }
  if (costUSD != null) obj.costUSD = costUSD
  return JSON.stringify(obj)
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

const NOW = Date.parse('2026-07-08T13:00:00.000Z')

describe('spend.mjs — the book, the window budget, the scorer (Task 2)', () => {
  it('Test 1: buildBook aggregates by session/model/day/agent; two builds deep-equal', () => {
    const logsDir = tmp('spend-book-')
    // 3 sessions, 2 models, main + sidechain.
    writeFileSync(
      join(logsDir, 'sess-A.jsonl'),
      [
        line({ sessionId: 'sess-A', model: 'claude-opus-4-8', ts: '2026-07-08T10:00:00.000Z' }),
        line({ sessionId: 'sess-A', model: 'claude-sonnet-4-5', isSidechain: true, ts: '2026-07-08T10:05:00.000Z' }),
      ].join('\n') + '\n',
    )
    writeFileSync(
      join(logsDir, 'sess-B.jsonl'),
      [line({ sessionId: 'sess-B', model: 'claude-opus-4-8', ts: '2026-07-07T22:00:00.000Z' })].join('\n') + '\n',
    )
    writeFileSync(
      join(logsDir, 'sess-C.jsonl'),
      [line({ sessionId: 'sess-C', model: 'claude-sonnet-4-5', ts: '2026-07-08T11:00:00.000Z' })].join('\n') + '\n',
    )

    const spendDir = tmp('spend-cache-')
    const b1 = buildBook({ logsDir, spendDir, cache: {}, now: NOW, persist: false })
    const b2 = buildBook({ logsDir, spendDir, cache: {}, now: NOW, persist: false })

    expect(b1).toEqual(b2) // determinism

    expect(b1.totals.events).toBe(4)
    expect(Object.keys(b1.bySession).sort()).toEqual(['sess-A', 'sess-B', 'sess-C'])
    expect(Object.keys(b1.byModel).sort()).toEqual(['claude-opus-4-8', 'claude-sonnet-4-5'])
    // by day: 2026-07-07 (1 event) + 2026-07-08 (3 events).
    expect(b1.byDay['2026-07-07'].events).toBe(1)
    expect(b1.byDay['2026-07-08'].events).toBe(3)
    // main vs subagent (isSidechain).
    expect(b1.byAgent.subagent.events).toBe(1)
    expect(b1.byAgent.main.events).toBe(3)
    expect(b1.pricingVersion).toBeTruthy()
    expect(b1.totals.usd).toBeGreaterThan(0)
  })

  it('Test 2: windowSpend sums only events inside the rolling window (boundary included)', () => {
    const logsDir = tmp('spend-win-')
    // inside (12:30), boundary (08:00 exactly = now-5h), outside (07:00).
    writeFileSync(
      join(logsDir, 's.jsonl'),
      [
        line({ ts: '2026-07-08T12:30:00.000Z' }),
        line({ ts: '2026-07-08T08:00:00.000Z' }), // exactly now-5h
        line({ ts: '2026-07-08T07:00:00.000Z' }), // outside
      ].join('\n') + '\n',
    )
    const book = buildBook({ logsDir, spendDir: tmp('spend-c2-'), cache: {}, now: NOW, persist: false })
    const w = windowSpend({ book, now: NOW, windowHours: 5 })
    expect(w.events).toBe(2) // 12:30 inside + 08:00 boundary; 07:00 excluded
    expect(w.usd).toBeGreaterThan(0)

    const empty = windowSpend({ book, now: NOW, windowHours: 0 })
    expect(empty).toEqual({ usd: 0, events: 0 })
  })

  it('Test 3: incremental cache parses only appended bytes; untouched not re-read; shrink reparses', () => {
    const logsDir = tmp('spend-inc-')
    const fileA = join(logsDir, 'a.jsonl')
    const fileB = join(logsDir, 'b.jsonl')
    writeFileSync(fileA, line({ sessionId: 'A', ts: '2026-07-08T10:00:00.000Z' }) + '\n')
    writeFileSync(fileB, line({ sessionId: 'B', ts: '2026-07-08T10:00:00.000Z' }) + '\n')

    const calls = []
    const spyRange = (p, start) => {
      calls.push({ p, start })
      return readFileSync(p).slice(start).toString('utf8')
    }

    const cache = {}
    const b1 = buildBook({ logsDir, spendDir: tmp('spend-c3-'), cache, now: NOW, persist: false, readRange: spyRange })
    expect(b1.totals.events).toBe(2)
    const firstReadCount = calls.length
    expect(firstReadCount).toBe(2) // both files read from 0 on the cold build
    const offsetA = cache.files[fileA].offset

    // Append ONE line to A; leave B untouched.
    calls.length = 0
    appendFileSync(fileA, line({ sessionId: 'A', ts: '2026-07-08T10:10:00.000Z' }) + '\n')
    const b2 = buildBook({ logsDir, spendDir: tmp('spend-c3b-'), cache, now: NOW, persist: false, readRange: spyRange })
    expect(b2.totals.events).toBe(3)
    // A read from its cached offset (appended bytes only); B not read at all.
    const aCall = calls.find((c) => c.p === fileA)
    const bCall = calls.find((c) => c.p === fileB)
    expect(aCall).toBeTruthy()
    expect(aCall.start).toBe(offsetA)
    expect(bCall).toBeUndefined() // untouched → not re-read

    // Replace A with a SHORTER file → invalidates the cache entry, reparses from 0.
    calls.length = 0
    writeFileSync(fileA, line({ sessionId: 'A', ts: '2026-07-08T09:00:00.000Z' }) + '\n')
    const b3 = buildBook({ logsDir, spendDir: tmp('spend-c3c-'), cache, now: NOW, persist: false, readRange: spyRange })
    const aReparse = calls.find((c) => c.p === fileA)
    expect(aReparse.start).toBe(0) // shrunk/replaced → reparse from zero
    expect(b3.bySession.A.events).toBe(1)
  })

  it('Test 4: readBudget default + capUsd null; writeBudget persists provenance', () => {
    const spendDir = tmp('spend-budget-')
    // missing → safe default.
    const def = readBudget({ spendDir })
    expect(def.windowHours).toBe(5)
    expect(def.capUsd).toBeNull()
    expect(def.warnAt).toEqual([0.7, 0.9])
    expect(DEFAULT_BUDGET.warnAt).toEqual([0.7, 0.9])

    // corrupt file → safe default (fail-open).
    writeFileSync(join(spendDir, 'budget.json'), '{ not json')
    expect(readBudget({ spendDir }).capUsd).toBeNull()

    // writeBudget with provenance.
    writeBudget({ windowHours: 8, capUsd: 25 }, { spendDir, by: 'founder', now: NOW })
    const back = readBudget({ spendDir })
    expect(back.capUsd).toBe(25)
    expect(back.windowHours).toBe(8)
    expect(back.warnAt).toEqual([0.7, 0.9]) // locked levels re-applied
    expect(back.by).toBe('founder')
    expect(typeof back.at).toBe('string')
  })

  it('Test 5: spendStats parse-coverage over 99 recognized + 1 unrecognized → 99', () => {
    const logsDir = tmp('spend-cov-')
    const lines = []
    for (let i = 0; i < 99; i++) lines.push(line({ id: `m${i}`, requestId: `r${i}` }))
    // one unfamiliar-shaped line that carries token usage (the drift counter).
    lines.push(JSON.stringify({ type: 'weird-future', usage: { input_tokens: 42 } }))
    writeFileSync(join(logsDir, 's.jsonl'), lines.join('\n') + '\n')

    const book = buildBook({ logsDir, spendDir: tmp('spend-c5-'), cache: {}, now: NOW, persist: false })
    expect(book.counters.recognized).toBe(99)
    expect(book.counters.unrecognized).toBe(1)

    const cov = spendStats('parse-coverage', { book })
    expect(cov).toBe(99)
    expect(Number.isFinite(cov)).toBe(true)
  })
})
