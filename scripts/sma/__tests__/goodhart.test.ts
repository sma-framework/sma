/**
 * Tests for scripts/sma/lib/goodhart.mjs (Phase 49.2 Plan 10, Task 1).
 *
 * The Goodhart integrity guards (D-49.2-14):
 *   - Test 1: signPredictions writes a countersign; verifySkeptic on the untouched
 *     plan -> {ok:true}.
 *   - Test 2: editing the predictions block after signing -> {ok:false,
 *     reason:'hash-mismatch'} — the countersign is VOID (PRED-POSTEDIT posture).
 *   - Test 3: a self-sign (countersign terminalId == implementer terminalId in the
 *     exec journal) -> {ok:false, reason:'self-sign'}; no exec journal yet ->
 *     {ok:true, deferred:true} (fail-open).
 *   - Test 4: sampleReceipts is pure — same seed same sample (exact fixture), a
 *     different seedSha selects a different sample on a 40-receipt fixture, floor
 *     guarantees >= 1 pick on tiny sets.
 *   - Test 5: auditReceipts re-runs SAMPLED receipts ONLY when isSafeCommand passes;
 *     a non-allowlisted command -> 'skipped-unsafe' with the runner NEVER invoked;
 *     verdicts append under domain 'sma.receipts-audit'.
 *   - Test 6 (immunity): near-miss entries present vs absent -> byte-identical
 *     calibration + audit outputs (no scoring path reads .sma/nearmiss/).
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  signPredictions,
  verifySkeptic,
  sampleReceipts,
  auditReceipts,
  recordNearMiss,
  planIdFromPath,
} from '../lib/goodhart.mjs'
import { observationOf } from '../lib/receipts.mjs'
import { readLedger, hitRate } from '../lib/calibration.mjs'

function tmp(prefix = 'goodhart-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function sha256(s: string): string {
  return createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/** A minimal PLAN.md with a predictions block. */
function planText(predBody: string[]): string {
  return ['---', 'phase: 49.2', 'plan: 10', 'predictions:', ...predBody, 'requirements: [X]', '---', '', '# body'].join('\n') + '\n'
}

const PRED_BODY = [
  '  - id: P1',
  '    claim: "a thing holds"',
  '    metric: m',
  '    check_command: node scripts/sma/cli.mjs integrity hazards --count-uncompensated',
  '    comparator: "=="',
  '    threshold: 0',
  '    horizon: "close"',
  '    domain: sma.integrity',
]

describe('planIdFromPath', () => {
  it('strips the -PLAN.md suffix', () => {
    expect(planIdFromPath('/a/b/49.2-10-PLAN.md')).toBe('49.2-10')
    expect(planIdFromPath('49.2-03-PLAN.md')).toBe('49.2-03')
  })
})

describe('signPredictions + verifySkeptic', () => {
  it('Test 1: signs the predictions block; verify on the untouched plan -> ok', () => {
    const dir = tmp()
    const skepticDir = join(dir, 'skeptic')
    const planPath = join(dir, '49.2-10-PLAN.md')
    const text = planText(PRED_BODY)
    writeFileSync(planPath, text)

    const rec = signPredictions({
      planPath,
      identity: { terminalId: 'skeptic-A', holderIdentity: 'skeptic@x' },
      dirs: { skepticDir },
      now: '2026-07-08T00:00:00Z',
    })
    expect(rec.planId).toBe('49.2-10')
    expect(rec.skeptic.terminalId).toBe('skeptic-A')
    expect(rec.predictionsHash).toHaveLength(64)

    // No exec journal yet -> distinctness deferred, but the countersign is valid.
    const v = verifySkeptic({ planPath, dirs: { skepticDir, execDir: join(dir, 'exec') } })
    expect(v.ok).toBe(true)
  })

  it('Test 2: editing the predictions block after signing voids the countersign', () => {
    const dir = tmp()
    const skepticDir = join(dir, 'skeptic')
    const planPath = join(dir, '49.2-10-PLAN.md')
    writeFileSync(planPath, planText(PRED_BODY))
    signPredictions({ planPath, identity: { terminalId: 'skeptic-A' }, dirs: { skepticDir } })

    // Edit the predictions block (change the threshold).
    const edited = PRED_BODY.map((l) => l.replace('threshold: 0', 'threshold: 1'))
    writeFileSync(planPath, planText(edited))

    const v = verifySkeptic({ planPath, dirs: { skepticDir, execDir: join(dir, 'exec') } })
    expect(v).toEqual({ ok: false, reason: 'hash-mismatch' })
  })

  it('Test 3: self-sign is rejected; no exec journal -> deferred', () => {
    const dir = tmp()
    const skepticDir = join(dir, 'skeptic')
    const execDir = join(dir, 'exec')
    const planPath = join(dir, '49.2-10-PLAN.md')
    writeFileSync(planPath, planText(PRED_BODY))

    // Unsigned -> unsigned reason.
    expect(verifySkeptic({ planPath, dirs: { skepticDir, execDir } })).toEqual({ ok: false, reason: 'unsigned' })

    // Sign with terminalId 'impl-1' (which will also be the implementer).
    signPredictions({ planPath, identity: { terminalId: 'impl-1' }, dirs: { skepticDir } })

    // No exec journal -> deferred (fail-open).
    expect(verifySkeptic({ planPath, dirs: { skepticDir, execDir } })).toEqual({ ok: true, deferred: true })

    // Now write an exec journal naming impl-1 as the implementer -> self-sign.
    mkdirSync(execDir, { recursive: true })
    appendFileSync(
      join(execDir, '49.2-10.jsonl'),
      JSON.stringify({ ts: '2026-07-08T00:00:00Z', event: 'task_complete', task: 1, terminalId: 'impl-1' }) + '\n',
    )
    expect(verifySkeptic({ planPath, dirs: { skepticDir, execDir } })).toEqual({ ok: false, reason: 'self-sign' })

    // A DISTINCT skeptic (re-sign as skeptic-Z) -> ok against the same journal.
    signPredictions({ planPath, identity: { terminalId: 'skeptic-Z' }, dirs: { skepticDir } })
    expect(verifySkeptic({ planPath, dirs: { skepticDir, execDir } })).toEqual({ ok: true })
  })
})

describe('sampleReceipts', () => {
  const receipts = Array.from({ length: 40 }, (_, i) => ({ id: `R${i}` }))

  it('Test 4: pure + deterministic + unsteerable + floored', () => {
    const a = sampleReceipts({ receipts, seedSha: 'sha-AAA', rate: 0.05, floor: 1 })
    const a2 = sampleReceipts({ receipts, seedSha: 'sha-AAA', rate: 0.05, floor: 1 })
    // rate 0.05 * 40 = 2 picks.
    expect(a.map((r) => r.id)).toHaveLength(2)
    // same seed -> identical sample (exact fixture outcome).
    expect(a.map((r) => r.id)).toEqual(a2.map((r) => r.id))

    // different seed -> a different sample on the 40-receipt fixture.
    const b = sampleReceipts({ receipts, seedSha: 'sha-BBB', rate: 0.05, floor: 1 })
    expect(b.map((r) => r.id)).not.toEqual(a.map((r) => r.id))

    // floor guarantees >= 1 on a tiny set (rate would round to >=1 anyway; prove floor path).
    const tiny = sampleReceipts({ receipts: [{ id: 'only' }], seedSha: 's', rate: 0.001, floor: 1 })
    expect(tiny.map((r) => r.id)).toEqual(['only'])

    // empty -> empty.
    expect(sampleReceipts({ receipts: [], seedSha: 's' })).toEqual([])
  })
})

describe('auditReceipts', () => {
  /** A receipt whose expected hash matches a runner that returns exit 0 + `stdout`. */
  function receiptFor(id: string, cmd: string, stdout: string): any {
    const expected = sha256(observationOf({ exitCode: 0, stdout, hashStdout: true }))
    return { id, assertion: id, check_command: cmd, expected_sha256: expected, hash_stdout: true, coverage_id: `cov-${id}` }
  }

  it('Test 5: re-runs safe sampled receipts; skips unsafe without invoking the runner; lands in sma.receipts-audit', () => {
    const dir = tmp()
    const calibrationDir = join(dir, 'calibration')
    // Build a fixture set where the sampled ones include a safe (verifies) and an unsafe one.
    // Use a large-enough set so the ceil(rate*n) sample is deterministic; force rate=1 to audit all.
    const safe = receiptFor('SAFE', 'node scripts/sma/cli.mjs chain-tip', 'the-output')
    const unsafe = { id: 'UNSAFE', assertion: 'x', check_command: 'rm -rf /', expected_sha256: 'a'.repeat(64), coverage_id: 'cov-U' }
    const runner = vi.fn((cmd: string) => ({ exitCode: 0, stdout: 'the-output' }))

    const { sampled, records } = auditReceipts({
      receipts: [safe, unsafe],
      seedSha: 'seed',
      runCommand: runner,
      dirs: { calibrationDir },
      rate: 1,
      floor: 2,
    })
    expect(sampled).toHaveLength(2)

    const byId = Object.fromEntries(records.map((r) => [r.id, r]))
    expect(byId.SAFE.verdict).toBe('hit')
    expect(byId.SAFE.receipt_verdict).toBe('verified')
    expect(byId.UNSAFE.verdict).toBe('skipped-unsafe')
    // The runner is invoked ONLY for the safe command — never for the unsafe one.
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0]).toBe('node scripts/sma/cli.mjs chain-tip')

    // Verdicts land under the SEPARATE audit domain.
    for (const r of records) expect(r.domain).toBe('sma.receipts-audit')
    const led = readLedger({ calibrationDir, domain: 'sma.receipts-audit' })
    expect(led.records.map((r) => r.id).sort()).toEqual(['SAFE', 'UNSAFE'])
  })

  it('Test 6 (immunity): near-miss entries never change calibration or audit outputs', () => {
    const safe = receiptFor('SAFE', 'node scripts/sma/cli.mjs chain-tip', 'out')
    const runner = () => ({ exitCode: 0, stdout: 'out' })

    // Run A: near-miss dir EMPTY.
    const dirA = tmp()
    const calA = join(dirA, 'calibration')
    const resA = auditReceipts({ receipts: [safe], seedSha: 's', runCommand: runner, dirs: { calibrationDir: calA }, rate: 1, floor: 1, now: 'T' })
    const ledA = readLedger({ calibrationDir: calA, domain: 'sma.receipts-audit' })
    const rateA = hitRate(ledA.records)

    // Run B: identical, but with 5 near-miss entries present.
    const dirB = tmp()
    const calB = join(dirB, 'calibration')
    const nmDir = join(dirB, 'nearmiss')
    for (let i = 0; i < 5; i++) recordNearMiss({ text: `near-miss ${i}`, identity: { terminalId: 't' }, dirs: { nearmissDir: nmDir } })
    const resB = auditReceipts({ receipts: [safe], seedSha: 's', runCommand: runner, dirs: { calibrationDir: calB }, rate: 1, floor: 1, now: 'T' })
    const ledB = readLedger({ calibrationDir: calB, domain: 'sma.receipts-audit' })
    const rateB = hitRate(ledB.records)

    // Audit records and calibration outputs are byte-identical with/without near-misses.
    expect(resB.records).toEqual(resA.records)
    expect(ledB.records).toEqual(ledA.records)
    expect(rateB).toEqual(rateA)
    // And the near-miss record carries NO metric field (nothing for a scorer to read).
    const nm = recordNearMiss({ text: 'x', dirs: { nearmissDir: nmDir } })
    expect(Object.keys(nm).sort()).toEqual(['at', 'terminalId', 'text'])
  })
})
