/**
 * Tests for scripts/sma/lib/grill.mjs (Phase 9.2 Plan 07, Task 1 — D-9.2-11).
 *
 * The /sma-grill challenge ledger: an unresolved challenge blocks the build; a
 * conversion is VERIFIED against the plan's real predictions block (parsePredictions
 * + validatePrediction), never trusted; a budget-aware pre-push planner spends depth
 * where the calibration ledger proves us historically miscalibrated.
 *
 * Pure over injected state — every dir is DI ({grillDir}); zero LLM; no child_process.
 *
 *   - Test 1: registerChallenge appends {id, status:'open', ...}; readChallenges folds
 *     later status lines over earlier by id; a corrupt line is skip-and-counted.
 *   - Test 2: resolveChallenge 'converted' verifies the named predictionId exists AND
 *     validates; an absent/invalid id keeps the challenge open ({ok:false}).
 *   - Test 3: 'withdrawn' needs a reason; 'accepted-risk' needs non-empty disposition.
 *   - Test 4: grillGate blocks while any challenge is open; allows when all resolved;
 *     grilled:false for a plan with no grill file (fail-open).
 *   - Test 5: prePushPlan ranks proven-bad → unproven → proven-good, budget-capped.
 *   - Test 6: challengeStats yield = pct of grilled plans with a landed challenge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  registerChallenge,
  readChallenges,
  resolveChallenge,
  grillGate,
  prePushPlan,
  challengeStats,
} from '../lib/grill.mjs'

let grillDir: string
let planPath: string

/** A minimal PLAN.md fixture carrying a real predictions block. */
const PLAN_FIXTURE = `---
phase: 9.2-test
plan: 07
predictions:
  - id: P-REAL-A
    claim: "a genuine falsifiable claim"
    metric: some_metric
    check_command: "node scripts/sma/cli.mjs grill --stats --metric challenge-yield"
    comparator: ">="
    threshold: 25
    horizon: "phase close"
    domain: sma.grill
  - id: P-BROKEN
    claim: "missing required fields"
    metric: broken
---

# body
`

beforeEach(() => {
  grillDir = mkdtempSync(join(tmpdir(), 'sma-grill-'))
  planPath = join(grillDir, 'plan-PLAN.md')
  writeFileSync(planPath, PLAN_FIXTURE, 'utf8')
})
afterEach(() => {
  rmSync(grillDir, { recursive: true, force: true })
})

describe('grill.mjs — the challenge ledger + build gate + pre-push planner', () => {
  it('Test 1 — registers, folds status by id, skips a corrupt line', () => {
    const a = registerChallenge(
      { planId: 'P1', promise: 'ships 10x', attack: 'no measured base', raisedBy: 'founder' },
      { grillDir },
    )
    expect(a.id).toBe('CH-P1-1')
    expect(a.status).toBe('open')
    const b = registerChallenge(
      { planId: 'P1', promise: 'zero divergence', attack: 'lazy verifier?', raisedBy: 'founder' },
      { grillDir },
    )
    expect(b.id).toBe('CH-P1-2')

    // A later status line supersedes the earlier open state (event-sourced fold).
    resolveChallenge(
      { planPath, planId: 'P1', challengeId: 'CH-P1-2', status: 'withdrawn', reason: 'covered elsewhere', by: 'founder' },
      { grillDir },
    )

    // Inject a corrupt line into the ledger file.
    const file = join(grillDir, 'P1.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8') + '{ this is not json\n', 'utf8')

    const { challenges, corrupt } = readChallenges({ planId: 'P1' }, { grillDir })
    expect(corrupt).toBe(1)
    const byId = Object.fromEntries(challenges.map((c) => [c.id, c]))
    expect(byId['CH-P1-1'].status).toBe('open')
    expect(byId['CH-P1-2'].status).toBe('withdrawn')
    expect(byId['CH-P1-2'].reason).toBe('covered elsewhere')
  })

  it('Test 2 — conversion is verified against the plan predictions (absent/invalid rejected)', () => {
    registerChallenge({ planId: 'P1', promise: 'p', attack: 'a', raisedBy: 'f' }, { grillDir })

    // absent prediction id → rejected, challenge stays open
    const absent = resolveChallenge(
      { planPath, planId: 'P1', challengeId: 'CH-P1-1', status: 'converted', predictionId: 'P-DOES-NOT-EXIST', by: 'f' },
      { grillDir },
    )
    expect(absent.ok).toBe(false)
    expect(absent.reason).toMatch(/not found|absent/i)
    expect(readChallenges({ planId: 'P1' }, { grillDir }).challenges[0].status).toBe('open')

    // invalid prediction (missing required fields) → rejected
    const invalid = resolveChallenge(
      { planPath, planId: 'P1', challengeId: 'CH-P1-1', status: 'converted', predictionId: 'P-BROKEN', by: 'f' },
      { grillDir },
    )
    expect(invalid.ok).toBe(false)
    expect(invalid.reason).toMatch(/invalid|missing/i)
    expect(readChallenges({ planId: 'P1' }, { grillDir }).challenges[0].status).toBe('open')

    // a real, valid prediction → converted
    const ok = resolveChallenge(
      { planPath, planId: 'P1', challengeId: 'CH-P1-1', status: 'converted', predictionId: 'P-REAL-A', by: 'f' },
      { grillDir },
    )
    expect(ok.ok).toBe(true)
    const c = readChallenges({ planId: 'P1' }, { grillDir }).challenges[0]
    expect(c.status).toBe('converted')
    expect(c.predictionId).toBe('P-REAL-A')
  })

  it('Test 3 — withdrawn needs a reason; accepted-risk needs a disposition', () => {
    registerChallenge({ planId: 'P1', promise: 'p', attack: 'a', raisedBy: 'f' }, { grillDir })

    // accepted-risk without disposition → rejected
    const bad = resolveChallenge(
      { planPath, planId: 'P1', challengeId: 'CH-P1-1', status: 'accepted-risk', by: 'f' },
      { grillDir },
    )
    expect(bad.ok).toBe(false)
    expect(readChallenges({ planId: 'P1' }, { grillDir }).challenges[0].status).toBe('open')

    // accepted-risk with disposition text → accepted
    const ok = resolveChallenge(
      { planPath, planId: 'P1', challengeId: 'CH-P1-1', status: 'accepted-risk', disposition: 'founder accepts the residual risk', by: 'founder' },
      { grillDir },
    )
    expect(ok.ok).toBe(true)
    expect(readChallenges({ planId: 'P1' }, { grillDir }).challenges[0].status).toBe('accepted-risk')

    // withdrawn without a reason → rejected
    registerChallenge({ planId: 'P2', promise: 'p', attack: 'a', raisedBy: 'f' }, { grillDir })
    const w = resolveChallenge(
      { planPath, planId: 'P2', challengeId: 'CH-P2-1', status: 'withdrawn', by: 'f' },
      { grillDir },
    )
    expect(w.ok).toBe(false)
  })

  it('Test 4 — grillGate: open blocks, all-resolved allows, no file → grilled:false', () => {
    // no grill file at all → fail-open (grilled:false, allowed:true)
    const none = grillGate({ planPath, planId: 'NOPE', dirs: { grillDir } })
    expect(none.allowed).toBe(true)
    expect(none.grilled).toBe(false)

    registerChallenge({ planId: 'P1', promise: 'p', attack: 'a', raisedBy: 'f' }, { grillDir })
    const blocked = grillGate({ planPath, planId: 'P1', dirs: { grillDir } })
    expect(blocked.allowed).toBe(false)
    expect(blocked.grilled).toBe(true)
    expect(blocked.open.length).toBe(1)

    resolveChallenge(
      { planPath, planId: 'P1', challengeId: 'CH-P1-1', status: 'converted', predictionId: 'P-REAL-A', by: 'f' },
      { grillDir },
    )
    const allowed = grillGate({ planPath, planId: 'P1', dirs: { grillDir } })
    expect(allowed.allowed).toBe(true)
    expect(allowed.grilled).toBe(true)
    expect(allowed.open.length).toBe(0)
  })

  it('Test 5 — prePushPlan ranks proven-bad → unproven → proven-good, budget-capped', () => {
    const planIndex = [
      { planId: 'A', files: ['src/bad/**'], domains: ['sma.bad'], order: 1 },
      { planId: 'B', files: ['src/good/**'], domains: ['sma.good'], order: 2 },
      { planId: 'C', files: ['src/new/**'], domains: ['sma.new'], order: 3 },
    ]
    // ledger: sma.bad is proven-bad (n>=5, low rate); sma.good is proven-good; sma.new absent (unproven)
    const ledger = [
      ...Array.from({ length: 6 }, () => ({ domain: 'sma.bad', verdict: 'miss' })),
      ...Array.from({ length: 6 }, () => ({ domain: 'sma.good', verdict: 'hit' })),
    ]
    const changedFiles = ['src/good/x.ts', 'src/new/y.ts', 'src/bad/z.ts', 'src/orphan/none.ts']
    const plan = prePushPlan({ changedFiles, planIndex, ledger, budget: 2, minN: 5, threshold: 0.6 })

    // budget-capped deep list
    expect(plan.deep.length).toBe(2)
    // proven-bad ranks first
    expect(plan.deep[0].domain).toBe('sma.bad')
    expect(plan.deep[0].tier).toBe(0)
    // the deep item names the most recent plan touching that domain
    expect(plan.deep[0].plan).toBe('A')
    // unproven (sma.new + unknown-from-orphan) ranks before proven-good
    const deepDomains = plan.deep.map((d) => d.domain)
    expect(deepDomains).not.toContain('sma.good') // proven-good pushed to light within budget 2
    // proven-good lands in light
    const lightDomains = plan.light.map((d) => d.domain)
    expect(lightDomains).toContain('sma.good')

    // empty ledger → everything unproven, still deterministic
    const empty = prePushPlan({ changedFiles, planIndex, ledger: [], budget: 3 })
    for (const d of empty.deep) expect(d.tier).toBe(1)
  })

  it('Test 6 — challengeStats yield = pct of grilled plans with a landed challenge', () => {
    // zero grilled plans → 0
    expect(challengeStats({ grillDir }).yieldPct).toBe(0)

    // plan P1: a challenge that lands; plan P2: a challenge that never lands
    registerChallenge({ planId: 'P1', promise: 'p', attack: 'a', raisedBy: 'f' }, { grillDir })
    resolveChallenge(
      { planPath, planId: 'P1', challengeId: 'CH-P1-1', status: 'converted', predictionId: 'P-REAL-A', by: 'f' },
      { grillDir },
    )
    resolveChallenge({ planPath, planId: 'P1', challengeId: 'CH-P1-1', status: 'landed', by: 'f' }, { grillDir })
    registerChallenge({ planId: 'P2', promise: 'p', attack: 'a', raisedBy: 'f' }, { grillDir })

    const stats = challengeStats({ grillDir })
    expect(stats.grilledPlans).toBe(2)
    expect(stats.plansWithLanded).toBe(1)
    expect(stats.yieldPct).toBe(50)
    // landed does not clobber the resolved status
    expect(readChallenges({ planId: 'P1' }, { grillDir }).challenges[0].status).toBe('converted')
    expect(readChallenges({ planId: 'P1' }, { grillDir }).challenges[0].landed).toBe(true)
  })
})
