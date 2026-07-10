/**
 * Tests for the budget reflexes (spend.checkSpend) + the loop-breaker (breaker.mjs)
 * — Phase 9.2 Plan 09, Task 3.
 *
 *   - Test 1 (checkSpend deciles): cap 10 + window 7.20 → ONE 70% WARN; deduped on the
 *     second same-session/decile call; crossing 90% fires the stronger WARN once.
 *   - Test 2 (soft-deny fence): deny ONLY for tool_name 'Task' at >=100% of a CONFIGURED
 *     cap; 'Edit' at 150% is WARN-only, never denied; the deny names cap + live + overrides.
 *   - Test 3 (report-only + fail-open): capUsd null → no warn/deny; a throwing book-builder
 *     → {allow} silently.
 *   - Test 4 (detectLoops): 10 fires of one ruleId+target in 30 min trips; 9 does not; 10
 *     spread over 3 h does not.
 *   - Test 5 (detectAndTrip + namespace fence): writes a marker with compensatingControl +
 *     reviewRequired; isBreakableRule rejects a guard/security ruleId (no marker).
 *   - Test 6 (isTripped / skip-once / re-arm): tripped after write; one 'breaker-skip'
 *     journal event per session; reArm deletes the marker + journals 'breaker-rearm'.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkSpend } from '../lib/spend.mjs'
import {
  detectLoops,
  detectAndTrip,
  isTripped,
  listMarkers,
  reArm,
  isBreakableRule,
  recordSkipOnce,
} from '../lib/breaker.mjs'
import { readJournal } from '../lib/journal.mjs'

function tmp(p) {
  return mkdtempSync(join(tmpdir(), p))
}

const NOW = Date.parse('2026-07-08T13:00:00.000Z')

describe('budget reflexes — checkSpend (Task 3)', () => {
  const budget = { windowHours: 5, capUsd: 10, warnAt: [0.7, 0.9] }

  it('Test 1: 70% decile fires once, dedups; 90% fires once on crossing', () => {
    const seen = { keys: {} }
    const base = { toolName: 'Edit', sessionId: 'sess-1' }

    const a = checkSpend(base, { budget, windowUsd: 7.2, now: NOW, seen, env: {} })
    expect(a.warnings.length).toBe(1) // one 70% warn
    expect(a.deny).toBeUndefined()

    const b = checkSpend(base, { budget, windowUsd: 7.2, now: NOW, seen, env: {} })
    expect(b.warnings.length).toBe(0) // same session + decile → deduped

    const c = checkSpend(base, { budget, windowUsd: 9.5, now: NOW, seen, env: {} })
    expect(c.warnings.length).toBe(1) // 70 deduped, 90 fires once
  })

  it('Test 2: soft-deny ONLY for Task at >=100% of a configured cap', () => {
    const denied = checkSpend(
      { toolName: 'Task', sessionId: 's' },
      { budget, windowUsd: 12, now: NOW, seen: { keys: {} }, env: {} },
    )
    expect(denied.deny).toBeTruthy()
    expect(denied.deny.reason).toMatch(/12/) // live number
    expect(denied.deny.reason).toMatch(/10/) // cap
    expect(denied.deny.reason).toMatch(/SMA_SPEND_DISABLE/) // kill-switch override
    expect(denied.deny.reason).toMatch(/set-cap/) // the other override

    const edit = checkSpend(
      { toolName: 'Edit', sessionId: 's2' },
      { budget, windowUsd: 15, now: NOW, seen: { keys: {} }, env: {} },
    )
    expect(edit.deny).toBeUndefined() // every non-Task tool is WARN-only forever
    expect(edit.warnings.length).toBeGreaterThan(0)
  })

  it('Test 3: capUsd null → report-only; a throwing book-builder → allow (fail-open)', () => {
    const reportOnly = checkSpend(
      { toolName: 'Task', sessionId: 's' },
      { budget: { windowHours: 5, capUsd: null, warnAt: [0.7, 0.9] }, windowUsd: 999, now: NOW, seen: { keys: {} }, env: {} },
    )
    expect(reportOnly.warnings.length).toBe(0)
    expect(reportOnly.deny).toBeUndefined()

    const throwing = checkSpend(
      { toolName: 'Task', sessionId: 's' },
      {
        budget,
        now: NOW,
        seen: { keys: {} },
        env: {},
        buildBook: () => {
          throw new Error('cache corrupt')
        },
      },
    )
    expect(throwing.deny).toBeUndefined()
    expect(Array.isArray(throwing.warnings)).toBe(true)
  })
})

describe('loop-breaker — breaker.mjs (Task 3)', () => {
  /** A journaled reflex-fire event at ts offset (ms before NOW). */
  function fire(ruleId, target, msBeforeNow, type = 'reflex') {
    const detail = type === 'reflex' ? { noteId: ruleId, target } : { gateId: ruleId, target }
    return { type, ts: new Date(NOW - msBeforeNow).toISOString(), scope: target, detail }
  }

  it('Test 4: 10 fires in 30 min trips; 9 does not; 10 over 3 h does not', () => {
    // 10 fires spread across ~29 min (all inside a 30-min window).
    const tight = []
    for (let i = 0; i < 10; i++) tight.push(fire('feedback_loop', 'src/x.ts', i * 3 * 60_000))
    const trips = detectLoops(tight, { threshold: 10, windowMs: 30 * 60_000, now: NOW })
    expect(trips.length).toBe(1)
    expect(trips[0].ruleId).toBe('feedback_loop')
    expect(trips[0].count).toBeGreaterThanOrEqual(10)
    expect(typeof trips[0].firstTs).toBe('string')
    expect(typeof trips[0].lastTs).toBe('string')

    // 9 fires → below threshold.
    const nine = tight.slice(0, 9)
    expect(detectLoops(nine, { threshold: 10, windowMs: 30 * 60_000, now: NOW }).length).toBe(0)

    // 10 fires spread over 3 h → no 30-min window holds 10.
    const spread = []
    for (let i = 0; i < 10; i++) spread.push(fire('feedback_loop', 'src/x.ts', i * 20 * 60_000))
    expect(detectLoops(spread, { threshold: 10, windowMs: 30 * 60_000, now: NOW }).length).toBe(0)
  })

  it('Test 5: detectAndTrip writes a compensating-control marker; namespace fence holds', () => {
    // isBreakableRule: reflex note ids + SMA gate ids only; guard/security rejected.
    expect(isBreakableRule('feedback_loop')).toBe(true)
    expect(isBreakableRule('GATE-PUSH')).toBe(true)
    expect(isBreakableRule('SMA-PRE-1')).toBe(false) // a guard invariant id
    expect(isBreakableRule('SEC-4')).toBe(false)
    expect(isBreakableRule('security-regression-guard')).toBe(false)
    expect(isBreakableRule('')).toBe(false)

    const journalDir = tmp('brk-jrnl-')
    const breakerDir = tmp('brk-mark-')
    // A real journal: 10 reflex fires of one note in 30 min + 10 fires of a guard id.
    const { appendEvent } = { appendEvent: null } // placeholder (unused)
    void appendEvent
    const events = []
    for (let i = 0; i < 10; i++) events.push(fire('feedback_loop', 'src/x.ts', i * 3 * 60_000))
    for (let i = 0; i < 10; i++) events.push(fire('SMA-PRE-1', 'src/y.ts', i * 3 * 60_000, 'gate'))

    const res = detectAndTrip({
      breakerDir,
      journalDir,
      by: 'tester',
      threshold: 10,
      windowMs: 30 * 60_000,
      now: NOW,
      readJournalFn: () => ({ events }),
    })
    // exactly one marker — the guard id is fenced out.
    expect(res.tripped.length).toBe(1)
    expect(res.tripped[0].ruleId).toBe('feedback_loop')
    expect(isTripped('feedback_loop', { breakerDir })).toBe(true)
    expect(isTripped('SMA-PRE-1', { breakerDir })).toBe(false)

    const markers = listMarkers({ breakerDir })
    expect(markers.length).toBe(1)
    const m = markers[0]
    expect(m.ruleId).toBe('feedback_loop')
    expect(m.reviewRequired).toBe(true)
    expect(typeof m.compensatingControl).toBe('string')
    expect(m.compensatingControl.length).toBeGreaterThan(0)
    expect(m.by).toBe('tester')
    expect(Number.isFinite(m.windowMs)).toBe(true)
    expect(m.tripCount).toBeGreaterThanOrEqual(10)
  })

  it('Test 6: isTripped / skip-once-per-session / re-arm with provenance', () => {
    const journalDir = tmp('brk-jrnl2-')
    const breakerDir = tmp('brk-mark2-')
    const events = []
    for (let i = 0; i < 10; i++) events.push(fire('feedback_x', 'src/z.ts', i * 3 * 60_000))
    detectAndTrip({ breakerDir, journalDir, by: 'x', threshold: 10, windowMs: 30 * 60_000, now: NOW, readJournalFn: () => ({ events }) })
    expect(isTripped('feedback_x', { breakerDir })).toBe(true)

    // skip-once: two calls, ONE 'breaker-skip' journal event for the session.
    const seen = { keys: {} }
    recordSkipOnce('feedback_x', { seen, journalDir, terminalId: 't1' })
    recordSkipOnce('feedback_x', { seen, journalDir, terminalId: 't1' })
    const skips = readJournal({ journalDir }).events.filter((e) => e.type === 'breaker-skip')
    expect(skips.length).toBe(1)

    // re-arm: deletes the marker + journals 'breaker-rearm' with provenance.
    const r = reArm('feedback_x', { breakerDir, journalDir, by: 'founder', terminalId: 't1' })
    expect(r.rearmed).toBe(true)
    expect(isTripped('feedback_x', { breakerDir })).toBe(false)
    const rearms = readJournal({ journalDir }).events.filter((e) => e.type === 'breaker-rearm')
    expect(rearms.length).toBe(1)
    expect(rearms[0].detail.by).toBe('founder')
  })
})
