/**
 * Tests for scripts/sma/lib/blind-verify.mjs (Phase 49.2 Plan 07, Task 2 — D-49.2-11).
 *
 * The tree-only re-derivation with a STRUCTURAL information barrier: «done» is
 * re-derived from the plan file + the code tree ALONE — the verifier takes NO
 * claimed/summary input, structurally refuses any *-SUMMARY.md / exec-journal read,
 * and the CLI freezes the blind verdicts to disk BEFORE the claimed side is parsed. A
 * claimed-pass / reproduced-fail DIVERGENCE is the heaviest calibration-ledger event —
 * appended via the V2 calibration.appendVerdict (calibration.mjs untouched) so plan 08's
 * ship-block and plan 10's canaries consume it.
 *
 *   - Test 1: deriveChecks extracts artifact/prediction/claim checks; empty → [].
 *   - Test 2 (the barrier): blindVerify takes no claimed input; a readFn spy proves no
 *     SUMMARY/exec-journal read; a SUMMARY artifact path scores 'refused-blind'.
 *   - Test 3: unsafe check_command → 'skipped-unsafe' (runner never invoked); throwing
 *     runner / non-numeric → 'error'; blindVerify never throws.
 *   - Test 4: compareToClaimed — divergence on claimed-pass/blind-fail; honest-fail
 *     records nothing; under-claim on blind-pass/claimed-fail; divergence classifies A.
 *   - Test 5: sequencing — compareToClaimed refuses until the frozen file exists.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  deriveChecks,
  blindVerify,
  compareToClaimed,
  divergenceStats,
  isForbiddenBlindPath,
} from '../lib/blind-verify.mjs'
import { classifyEvent } from '../lib/consequences.mjs'
import { readLedger } from '../lib/calibration.mjs'

let root: string
let planPath: string
let dirs: { blindDir: string; calibrationDir: string }

const PLAN = `---
phase: 49.2-test
plan: 07
must_haves:
  truths:
    - "a truth"
  artifacts:
    - path: real.mjs
      contains: "grillGate"
    - path: missing.mjs
      contains: "nope"
    - path: some-SUMMARY.md
      contains: "leak"
  key_links:
    - "a link"
predictions:
  - id: P-SAFE
    claim: "a safe scored claim"
    metric: m
    check_command: "node scripts/sma/cli.mjs grill --stats --metric challenge-yield"
    comparator: ">="
    threshold: 0
    horizon: "h"
    domain: sma.verification
  - id: P-UNSAFE
    claim: "an unsafe command"
    metric: m
    check_command: "rm -rf /"
    comparator: ">="
    threshold: 0
    horizon: "h"
    domain: sma.verification
---

# body
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-blind-'))
  planPath = join(root, 'x-PLAN.md')
  writeFileSync(planPath, PLAN, 'utf8')
  writeFileSync(join(root, 'real.mjs'), 'export function grillGate(){}\n', 'utf8')
  dirs = { blindDir: join(root, 'blind'), calibrationDir: join(root, 'calibration') }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('blind-verify.mjs — tree-only re-derivation + divergence-as-heaviest-event', () => {
  it('Test 1 — deriveChecks extracts artifact + prediction + claim checks; empty is honest', () => {
    const { checks } = deriveChecks({ planPath, readFn: (p: string) => require('node:fs').readFileSync(p, 'utf8') })
    const sources = checks.map((c: any) => c.source)
    expect(sources).toContain('artifact')
    expect(sources).toContain('prediction')
    // three artifacts + two predictions
    expect(checks.filter((c: any) => c.source === 'artifact').length).toBe(3)
    expect(checks.filter((c: any) => c.source === 'prediction').length).toBe(2)

    // a plan with none of the three yields an honest empty list, never a throw
    const empty = join(root, 'empty-PLAN.md')
    writeFileSync(empty, '---\nphase: x\n---\n# body\n', 'utf8')
    const res = deriveChecks({ planPath: empty, readFn: (p: string) => require('node:fs').readFileSync(p, 'utf8') })
    expect(res.checks).toEqual([])
  })

  it('Test 2 — the barrier: no SUMMARY/exec-journal read; a SUMMARY artifact → refused-blind', () => {
    const reads: string[] = []
    const readFn = (p: string) => {
      reads.push(p)
      return require('node:fs').readFileSync(p, 'utf8')
    }
    const runCommand = () => '0'
    const res = blindVerify({ planPath, runCommand, readFn, dirs })

    // no read ever touched a SUMMARY or the exec-journal.
    for (const p of reads) {
      expect(/-SUMMARY\.md$/i.test(p)).toBe(false)
      expect(/exec-journal/i.test(p)).toBe(false)
    }
    // the artifact pointing at a SUMMARY file scored refused-blind, WITHOUT a read.
    const refused = res.verdicts.find((v: any) => /some-SUMMARY\.md/i.test(v.path ?? ''))
    expect(refused.verdict).toBe('refused-blind')
    // blindVerify accepts NO claimed input — the function arity carries no such param.
    expect(res.frozenPath && existsSync(res.frozenPath)).toBe(true)
  })

  it('Test 3 — unsafe command skipped (runner never invoked); throwing/non-numeric → error; never throws', () => {
    let invokedWith: string[] = []
    const runCommand = (cmd: string) => {
      invokedWith.push(cmd)
      if (/challenge-yield/.test(cmd)) return '0'
      throw new Error('boom')
    }
    let res: any
    expect(() => {
      res = blindVerify({ planPath, runCommand, readFn: (p: string) => require('node:fs').readFileSync(p, 'utf8'), dirs })
    }).not.toThrow()

    const unsafe = res.verdicts.find((v: any) => v.id === 'P-UNSAFE')
    expect(unsafe.verdict).toBe('skipped-unsafe')
    // the runner was NEVER invoked for the unsafe command.
    expect(invokedWith.some((c) => /rm -rf/.test(c))).toBe(false)

    const safe = res.verdicts.find((v: any) => v.id === 'P-SAFE')
    expect(safe.verdict).toBe('pass') // 0 >= 0
  })

  it('Test 4 — compareToClaimed: divergence / honest-fail / under-claim; divergence is class A', () => {
    const runCommand = () => '0'
    blindVerify({ planPath, runCommand, readFn: (p: string) => require('node:fs').readFileSync(p, 'utf8'), dirs })

    // The claimed side (parsed in the CLI layer, AFTER the freeze): claims everything passed.
    const claimed = [
      { id: 'missing.mjs', verdict: 'pass' }, // blind = fail (missing) → DIVERGENCE
      { id: 'real.mjs', verdict: 'fail' }, // blind = pass → under-claim
      { id: 'P-SAFE', verdict: 'pass' }, // blind = pass → agree, nothing
    ]
    const cmp = compareToClaimed({ claimed, planId: 'x', dirs })
    expect(cmp.ok).toBe(true)
    expect(cmp.divergences.length).toBe(1)
    expect(cmp.divergences[0].checkId).toBe('missing.mjs')
    expect(cmp.underClaims.length).toBe(1)

    // the divergence landed in the ledger with kind:'divergence' AND classifies as class A.
    const { records } = readLedger({ calibrationDir: dirs.calibrationDir })
    const div = records.find((r: any) => r.kind === 'divergence')
    expect(div).toBeDefined()
    expect(classifyEvent(div)).toBe('A')
    // an under-claim is a plain note — NOT a divergence, carries no class.
    const uc = records.find((r: any) => r.kind === 'under-claim')
    expect(uc).toBeDefined()
    expect(classifyEvent(uc)).toBe(null)

    // divergenceStats counts it.
    expect(divergenceStats({ calibrationDir: dirs.calibrationDir }).count).toBe(1)
  })

  it('Test 6 — INPUT BARRIER: a SUMMARY input path is structurally refused, nothing frozen, ledger untouched (D-49.2-11, gap 2)', () => {
    // A SUMMARY-class input is refused by the predicate the CLI guards on.
    const summaryInput = join(root, '49.2-03-SUMMARY.md')
    writeFileSync(
      summaryInput,
      '---\nphase: 49.2-test\nreceipts:\n  - id: R1\n    check_command: "node scripts/sma/cli.mjs grill --stats --metric challenge-yield"\n    expected_sha256: deadbeef\n---\n# summary\n',
      'utf8',
    )
    expect(isForbiddenBlindPath(summaryInput)).toBe(true)
    expect(isForbiddenBlindPath(planPath)).toBe(false) // a -PLAN.md is allowed

    // deriveChecks refuses BEFORE any read.
    const reads: string[] = []
    const readFn = (p: string) => {
      reads.push(p)
      return require('node:fs').readFileSync(p, 'utf8')
    }
    const derived = deriveChecks({ planPath: summaryInput, readFn })
    expect(derived.refused).toBe(true)
    expect(derived.checks).toEqual([])
    expect(reads).toEqual([]) // the SUMMARY was never read

    // blindVerify refuses: no verdicts, NOTHING frozen.
    const res: any = blindVerify({ planPath: summaryInput, runCommand: () => '0', readFn, dirs })
    expect(res.refused).toBe(true)
    expect(res.verdicts).toEqual([])
    expect(res.frozenPath).toBe(null)
    expect(existsSync(join(dirs.blindDir, '49.2-03.json'))).toBe(false)

    // the calibration ledger was NEVER touched (no divergence manufactured).
    const { records } = readLedger({ calibrationDir: dirs.calibrationDir })
    expect(records.length).toBe(0)
  })

  it('Test 5 — sequencing: compareToClaimed refuses until the frozen blind file exists', () => {
    // no freeze yet → refuse (the claimed side can never contaminate the blind pass)
    const before = compareToClaimed({ claimed: [{ id: 'real.mjs', verdict: 'pass' }], planId: 'x', dirs })
    expect(before.ok).toBe(false)

    // freeze, then compare succeeds
    blindVerify({ planPath, runCommand: () => '0', readFn: (p: string) => require('node:fs').readFileSync(p, 'utf8'), dirs })
    const after = compareToClaimed({ claimed: [{ id: 'real.mjs', verdict: 'pass' }], planId: 'x', dirs })
    expect(after.ok).toBe(true)
  })
})
