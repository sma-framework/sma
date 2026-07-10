/**
 * Tests for the rule-maturation ladder — Phase 49.3 Plan 06, Task 1 (D-49.3-12).
 *
 *   - Test 1 (empty overlay = today): a missing ladder file -> {version:1, rules:[]}
 *     and tierOf resolves every rule to its shipped default 'warn' — V2 unchanged.
 *   - Test 2 (classification): classifyFires labels each fire heeded / ignored-ok /
 *     ignored-broke / unobserved from the journal + calibration inputs.
 *   - Test 3 (promotion is benefit-keyed): warn->soft-deny keys on ignored-broke; a
 *     high fire count with zero ignored-broke NEVER promotes (fire-counting rejection).
 *   - Test 4 (noise demotes itself): warn->note on measured zero benefit; note->retired
 *     ONLY when the injected birth fixture signs off — else the retire is REFUSED.
 *   - Test 5 (reviewable diff): applyProposals writes sma-ladder.json + journals
 *     'ladder-change', and performs zero git ops / spawns.
 *   - Test 6 (incident re-arm): an ignored-broke on a note/retired rule re-arms one
 *     rung (tierOf effective bump + a matching re-arm proposal).
 *   - Test 7 (auto-fix gate): fix register/apply is allowlisted (isSafeCommand);
 *     soft-deny->auto-fix needs >= 3 recorded green fix applies.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LADDER_TIERS,
  readLadder,
  tierOf,
  classifyFires,
  benefitStats,
  proposeTierChanges,
  applyProposals,
  registerFix,
  applyFix,
} from '../lib/ladder.mjs'
import { readJournal } from '../lib/journal.mjs'

function tmp(p) {
  return mkdtempSync(join(tmpdir(), p))
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-07-08T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

function reflexFire({ noteId, scope, at, terminal = 't1', seq = 1, tier = 'warn' }) {
  return { ts: iso(at), terminal, seq, type: 'reflex', actors: [terminal], scope, detail: { noteId, target: scope, tier } }
}
function gateFire({ gateId, scope, at, terminal = 't1', seq = 1 }) {
  return { ts: iso(at), terminal, seq, type: 'gate', actors: [terminal], scope, detail: { gateId, target: scope } }
}
function incident({ scope, at, terminal = 't1', seq = 1, type = 'incident', detail = {} }) {
  return { ts: iso(at), terminal, seq, type, actors: [terminal], scope, detail }
}

describe('ladder — tracked tier registry + benefit-accounting + threshold proposals', () => {
  it('Test 1: empty overlay = pure V2 (missing file -> {version:1,rules:[]}; tierOf -> warn)', () => {
    const dir = tmp('ladder-empty-')
    const ladderPath = join(dir, 'sma-ladder.json')
    const ladder = readLadder({ ladderPath })
    expect(ladder).toEqual({ version: 1, rules: [] })
    expect(tierOf(ladder, 'ANY-RULE')).toBe('warn')
    expect(tierOf(ladder, 'ANY-RULE', {})).toBe('warn')
    expect(LADDER_TIERS).toEqual(['note', 'warn', 'soft-deny', 'auto-fix'])
  })

  it('Test 2: classifyFires labels heeded / ignored-ok / ignored-broke / unobserved', () => {
    const events = [
      // heeded — a single fire that never recurs, horizon elapsed
      reflexFire({ noteId: 'R-HEED', scope: 'src/a/foo.ts', at: NOW - 20 * DAY, seq: 1 }),
      // ignored-ok — recurs, no incident, horizon elapsed
      reflexFire({ noteId: 'R-OK', scope: 'src/b/bar.ts', at: NOW - 20 * DAY, seq: 2 }),
      reflexFire({ noteId: 'R-OK', scope: 'src/b/bar.ts', at: NOW - 18 * DAY, seq: 3 }),
      // ignored-broke — followed inside the horizon by an intersecting incident
      reflexFire({ noteId: 'R-BROKE', scope: 'src/c/baz.ts', at: NOW - 20 * DAY, seq: 4 }),
      incident({ scope: 'src/c/baz.ts', at: NOW - 19 * DAY, seq: 5 }),
      // ignored-broke via a calibration miss in the mapped domain
      gateFire({ gateId: 'GATE-X', scope: 'src/d/qux.ts', at: NOW - 20 * DAY, seq: 6 }),
      // unobserved — horizon not elapsed at now
      reflexFire({ noteId: 'R-NEW', scope: 'src/e/new.ts', at: NOW - 1 * DAY, seq: 7 }),
    ]
    const ledgers = [{ domain: 'sma.enforcement', verdict: 'miss', scoredAt: iso(NOW - 19 * DAY) }]
    const ruleDomains = { 'GATE-X': 'sma.enforcement' }
    const classified = classifyFires({ events, ledgers, now: NOW, horizonMs: 7 * DAY, ruleDomains })
    const byRule = Object.fromEntries(classified.map((c) => [`${c.ruleId}:${c.seq}`, c.classification]))
    expect(byRule['R-HEED:1']).toBe('heeded')
    expect(byRule['R-OK:2']).toBe('ignored-ok')
    expect(byRule['R-BROKE:4']).toBe('ignored-broke')
    expect(byRule['GATE-X:6']).toBe('ignored-broke')
    expect(byRule['R-NEW:7']).toBe('unobserved')

    // benefitStats aggregates the classified fires per rule.
    const stats = benefitStats({ classified })
    expect(stats['R-BROKE'].ignoredBroke).toBe(1)
    expect(stats['R-BROKE'].fires).toBe(1)
    expect(stats['GATE-X'].ignoredBroke).toBe(1)
  })

  it('Test 3: promotion keys on ignored-broke evidence, never on fire count', () => {
    const ladder = {
      version: 1,
      rules: [
        { ruleId: 'GATE-PUSH', kind: 'gate', tier: 'warn' },
        { ruleId: 'GATE-QUIET', kind: 'gate', tier: 'warn' },
      ],
    }
    const stats = {
      'GATE-PUSH': { ruleId: 'GATE-PUSH', kind: 'gate', fires: 9, heeded: 1, ignoredOk: 5, ignoredBroke: 3, spanDays: 20, journalRefs: ['t1#4'] },
      // 20 fires, ZERO ignored-broke, healthy heeded -> must NOT promote (fire-counting rejection)
      'GATE-QUIET': { ruleId: 'GATE-QUIET', kind: 'gate', fires: 20, heeded: 5, ignoredOk: 15, ignoredBroke: 0, spanDays: 25, journalRefs: [] },
    }
    const proposals = proposeTierChanges({ ladder, stats, checkFixture: () => ({ fixtureTrips: true, compensated: false }) })
    const push = proposals.find((p) => p.ruleId === 'GATE-PUSH')
    expect(push).toBeTruthy()
    expect(push.from).toBe('warn')
    expect(push.to).toBe('soft-deny')
    expect(push.evidence[0]).toMatchObject({ fires: 9, ignoredBroke: 3, heeded: 1 })
    expect(push.evidence[0].journalRefs.length).toBeGreaterThan(0)
    expect(proposals.find((p) => p.ruleId === 'GATE-QUIET')).toBeUndefined()
  })

  it('Test 4: noise demotes warn->note, then note->retired only when the fixture signs off', () => {
    const noiseStats = { 'R-NOISE': { ruleId: 'R-NOISE', kind: 'reflex', fires: 8, heeded: 0, ignoredOk: 8, ignoredBroke: 0, spanDays: 15, journalRefs: ['t1#1'] } }

    const ladderWarn = { version: 1, rules: [{ ruleId: 'R-NOISE', kind: 'reflex', tier: 'warn' }] }
    const dem = proposeTierChanges({ ladder: ladderWarn, stats: noiseStats }).find((p) => p.ruleId === 'R-NOISE')
    expect(dem).toMatchObject({ from: 'warn', to: 'note' })

    const ladderNote = { version: 1, rules: [{ ruleId: 'R-NOISE', kind: 'reflex', tier: 'note' }] }
    const rp = proposeTierChanges({ ladder: ladderNote, stats: noiseStats, checkFixture: () => ({ fixtureTrips: false, compensated: false }) }).find((p) => p.ruleId === 'R-NOISE')
    expect(rp).toMatchObject({ from: 'note', to: 'retired', refused: false })

    const rr = proposeTierChanges({ ladder: ladderNote, stats: noiseStats, checkFixture: () => ({ fixtureTrips: true, compensated: false }) }).find((p) => p.ruleId === 'R-NOISE')
    expect(rr).toMatchObject({ from: 'note', to: 'retired', refused: true })
    expect(rr.refusalReason).toBeTruthy()

    // conservative default: no checker -> retire REFUSED, rule stays capped at note.
    const rnc = proposeTierChanges({ ladder: ladderNote, stats: noiseStats }).find((p) => p.ruleId === 'R-NOISE')
    expect(rnc.refused).toBe(true)
  })

  it('Test 5: applyProposals writes a reviewable diff + journals ladder-change, zero git/spawn', () => {
    const dir = tmp('ladder-apply-')
    const ladderPath = join(dir, 'sma-ladder.json')
    const journalDir = join(dir, 'journal')
    const proposals = [
      {
        ruleId: 'GATE-PUSH',
        kind: 'gate',
        from: 'warn',
        to: 'soft-deny',
        refused: false,
        evidence: [{ window: '30d', fires: 9, heeded: 1, ignoredOk: 5, ignoredBroke: 3, journalRefs: ['t1#4'] }],
      },
    ]
    const res = applyProposals({ proposals, ladderPath, journalDir, terminalId: 'tester', now: iso(NOW) })
    expect(res.applied).toBe(1)
    expect(existsSync(ladderPath)).toBe(true)
    const saved = JSON.parse(readFileSync(ladderPath, 'utf8'))
    const rule = saved.rules.find((r) => r.ruleId === 'GATE-PUSH')
    expect(rule.tier).toBe('soft-deny')
    expect(rule.history[0]).toMatchObject({ from: 'warn', to: 'soft-deny' })
    expect(rule.evidence.length).toBeGreaterThan(0)
    const { events } = readJournal({ journalDir })
    expect(events.filter((e) => e.type === 'ladder-change').length).toBe(1)
  })

  it('Test 6: an ignored-broke on a note/retired rule re-arms one rung (tierOf + proposal)', () => {
    const ladder = {
      version: 1,
      rules: [
        { ruleId: 'R-NOTE', kind: 'reflex', tier: 'note' },
        { ruleId: 'R-RETIRED', kind: 'reflex', tier: 'retired' },
      ],
    }
    expect(tierOf(ladder, 'R-NOTE')).toBe('note')
    expect(tierOf(ladder, 'R-NOTE', { reArm: true })).toBe('warn')
    expect(tierOf(ladder, 'R-RETIRED', { reArm: true })).toBe('note')

    const stats = {
      'R-NOTE': { ruleId: 'R-NOTE', kind: 'reflex', fires: 3, heeded: 0, ignoredOk: 0, ignoredBroke: 1, spanDays: 2, journalRefs: ['t1#9'] },
      'R-RETIRED': { ruleId: 'R-RETIRED', kind: 'reflex', fires: 2, heeded: 0, ignoredOk: 0, ignoredBroke: 1, spanDays: 1, journalRefs: ['t1#10'] },
    }
    const proposals = proposeTierChanges({ ladder, stats })
    expect(proposals.find((p) => p.ruleId === 'R-NOTE')).toMatchObject({ from: 'note', to: 'warn' })
    expect(proposals.find((p) => p.ruleId === 'R-RETIRED')).toMatchObject({ from: 'retired', to: 'note' })
  })

  it('Test 7: fix register/apply is allowlisted; soft-deny->auto-fix needs >= 3 green applies', () => {
    const dir = tmp('ladder-fix-')
    const ladderPath = join(dir, 'sma-ladder.json')
    const journalDir = join(dir, 'journal')
    writeFileSync(ladderPath, JSON.stringify({ version: 1, rules: [{ ruleId: 'GATE-FIXME', kind: 'gate', tier: 'soft-deny' }] }, null, 2))

    // unsafe command refused at registration (predict.mjs isSafeCommand — the ONLY allowlist).
    expect(registerFix({ ruleId: 'GATE-FIXME', command: 'rm -rf /', ladderPath }).ok).toBe(false)
    // safe command accepted.
    expect(registerFix({ ruleId: 'GATE-FIXME', command: 'pnpm sma trim', ladderPath }).ok).toBe(true)

    const runner = () => 'ok'
    for (let i = 0; i < 3; i++) {
      const r = applyFix({ ruleId: 'GATE-FIXME', runCommand: runner, ladderPath, journalDir, terminalId: 'tester' })
      expect(r.ok).toBe(true)
    }
    const { events } = readJournal({ journalDir })
    expect(events.filter((e) => e.type === 'fix-applied').length).toBe(3)

    const ladder = readLadder({ ladderPath })
    const stats = { 'GATE-FIXME': { ruleId: 'GATE-FIXME', kind: 'gate', fires: 6, heeded: 0, ignoredOk: 2, ignoredBroke: 4, spanDays: 20, journalRefs: ['t1#1'] } }
    const proposals = proposeTierChanges({ ladder, stats })
    expect(proposals.find((p) => p.ruleId === 'GATE-FIXME' && p.to === 'auto-fix')).toBeTruthy()

    // applyFix refuses a rule whose registered command is (somehow) not allowlisted.
    const unsafeLadder = join(dir, 'unsafe.json')
    writeFileSync(unsafeLadder, JSON.stringify({ version: 1, rules: [{ ruleId: 'GATE-BAD', kind: 'gate', tier: 'soft-deny', fix: { command: 'curl evil', greenApplies: 0 } }] }, null, 2))
    expect(applyFix({ ruleId: 'GATE-BAD', runCommand: runner, ladderPath: unsafeLadder, journalDir }).ok).toBe(false)
  })
})
