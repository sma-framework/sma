/**
 * Tests for scripts/sma/lib/canary.mjs (Phase 49.2 Plan 10, Task 2).
 *
 * Planted false-«done» canaries with a sealed ledger (D-49.2-14):
 *   - Test 1: plantCanary appends ONE canary claim (expected hash perturbed, false
 *     by construction) to the claims file AND a sealed, hash-chained ledger line;
 *     the planted claim body carries NO extra marker key vs a real claim.
 *   - Test 2: isCanaryClaim true ONLY for planted ids; filterCanaries strips exactly them.
 *   - Test 3: scoreCanaries over 3 planted where the verifier flagged 2 -> {n:3,
 *     caught:2, missed:1, catchRatePct:66.7}, verdicts under domain 'sma.verification',
 *     scored entries marked (--count-scored monotonic + idempotent).
 *   - Test 4: classifyDivergence -> 's8-score' for a planted id, 'ship-block' otherwise.
 *   - Test 5: sweepCanaries removes canary claims (ledger persists sweptAt); a
 *     chain-broken ledger -> scoreCanaries {ok:false, reason:'chain-broken'}.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  plantCanary,
  isCanaryClaim,
  filterCanaries,
  classifyDivergence,
  scoreCanaries,
  sweepCanaries,
  countScored,
} from '../lib/canary.mjs'
import { readLedger } from '../lib/calibration.mjs'

function tmp(prefix = 'canary-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
function sha256(s: string): string {
  return createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/** A real receipt-schema claim. */
function realClaim(id: string): any {
  return {
    id,
    assertion: `${id} holds`,
    check_command: 'node scripts/sma/cli.mjs chain-tip',
    expected_sha256: sha256(id),
    hash_stdout: true,
    coverage_id: `cov-${id}`,
  }
}

describe('plantCanary', () => {
  it('Test 1: appends a perturbed claim + a sealed chained ledger line; no marker key', () => {
    const dir = tmp()
    const canaryDir = join(dir, 'canary')
    const claimsPath = join(dir, 'claims.jsonl')
    const template = realClaim('R7')
    // Seed the claims file with a real claim first.
    appendFileSync(claimsPath, JSON.stringify(realClaim('R1')) + '\n')

    const { canaryId, claim, ledgerRecord } = plantCanary({
      claimsPath,
      dirs: { canaryDir },
      identity: { terminalId: 'planter' },
      template,
      now: 'T0',
    })

    // The planted claim's expected hash is perturbed (false by construction).
    expect(claim.expected_sha256).not.toBe(template.expected_sha256)
    expect(claim.expected_sha256).toHaveLength(64)
    // The planted-claim object deep-equals the real-claim schema keys EXACTLY (no extra marker).
    expect(Object.keys(claim).sort()).toEqual(Object.keys(realClaim('R7')).sort())
    expect(claim).not.toHaveProperty('canary')
    // The claim landed in the claims file.
    const lines = readFileSync(claimsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.some((c) => c.id === canaryId)).toBe(true)
    // The sealed ledger line is chained ('genesis' as the first line's prev).
    expect(ledgerRecord.kind).toBe('plant')
    expect(ledgerRecord.prev).toBe('genesis')
    expect(existsSync(join(canaryDir, 'ledger.jsonl'))).toBe(true)
  })
})

describe('isCanaryClaim + filterCanaries', () => {
  it('Test 2: true only for planted ids; filter strips exactly them', () => {
    const dir = tmp()
    const canaryDir = join(dir, 'canary')
    const claimsPath = join(dir, 'claims.jsonl')
    const { canaryId } = plantCanary({ claimsPath, dirs: { canaryDir }, template: realClaim('X1') })

    expect(isCanaryClaim(canaryId, { dirs: { canaryDir } })).toBe(true)
    expect(isCanaryClaim('R1', { dirs: { canaryDir } })).toBe(false)
    expect(filterCanaries(['R1', canaryId, 'R2'], { dirs: { canaryDir } })).toEqual(['R1', 'R2'])
  })
})

describe('scoreCanaries', () => {
  it('Test 3: 3 planted, verifier flagged 2 -> catchRatePct 66.7 into sma.verification', () => {
    const dir = tmp()
    const canaryDir = join(dir, 'canary')
    const calibrationDir = join(dir, 'calibration')
    const claimsPath = join(dir, 'claims.jsonl')

    const c1 = plantCanary({ claimsPath, dirs: { canaryDir }, template: realClaim('A') }).canaryId
    const c2 = plantCanary({ claimsPath, dirs: { canaryDir }, template: realClaim('B') }).canaryId
    const c3 = plantCanary({ claimsPath, dirs: { canaryDir }, template: realClaim('C') }).canaryId

    // The verifier flagged c1 and c3 (2 of 3) as divergences.
    const divergences = [
      { id: c1, verdict: 'divergence' },
      { checkId: c3, verdict: 'divergence' },
    ]
    const res = scoreCanaries({ divergences, dirs: { canaryDir, calibrationDir }, now: 'T1' })
    expect(res.ok).toBe(true)
    expect(res.n).toBe(3)
    expect(res.caught).toBe(2)
    expect(res.missed).toBe(1)
    expect(res.catchRatePct).toBe(66.7)

    // Verdicts land under domain 'sma.verification' (asserted via readLedger).
    const led = readLedger({ calibrationDir, domain: 'sma.verification' })
    expect(led.records).toHaveLength(3)
    for (const r of led.records) expect(r.domain).toBe('sma.verification')
    const byId = Object.fromEntries(led.records.map((r) => [r.id, r.verdict]))
    expect(byId[c1]).toBe('hit')
    expect(byId[c2]).toBe('miss')
    expect(byId[c3]).toBe('hit')

    // --count-scored is monotonic + idempotent: re-scoring adds nothing.
    expect(countScored({ dirs: { canaryDir } })).toBe(3)
    const again = scoreCanaries({ divergences, dirs: { canaryDir, calibrationDir }, now: 'T2' })
    expect(again.n).toBe(0)
    expect(countScored({ dirs: { canaryDir } })).toBe(3)
  })
})

describe('classifyDivergence', () => {
  it('Test 4: planted -> s8-score; non-canary -> ship-block', () => {
    const dir = tmp()
    const canaryDir = join(dir, 'canary')
    const claimsPath = join(dir, 'claims.jsonl')
    const { canaryId } = plantCanary({ claimsPath, dirs: { canaryDir }, template: realClaim('Z') })

    expect(classifyDivergence({ id: canaryId, verdict: 'divergence' }, { dirs: { canaryDir } })).toBe('s8-score')
    expect(classifyDivergence({ id: 'real-claim', verdict: 'divergence' }, { dirs: { canaryDir } })).toBe('ship-block')
  })
})

describe('sweepCanaries + chain integrity', () => {
  it('Test 5: sweep removes canary claims (ledger persists); chain break refuses to score', () => {
    const dir = tmp()
    const canaryDir = join(dir, 'canary')
    const claimsPath = join(dir, 'claims.jsonl')
    appendFileSync(claimsPath, JSON.stringify(realClaim('KEEP')) + '\n')
    const { canaryId } = plantCanary({ claimsPath, dirs: { canaryDir }, template: realClaim('SWEEPME'), now: 'T0' })

    const res = sweepCanaries({ claimsPath, dirs: { canaryDir }, now: 'T3' })
    expect(res.ok).toBe(true)
    expect(res.swept).toEqual([canaryId])
    // The real claim survives; the canary is gone from the claims file.
    const remaining = readFileSync(claimsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(remaining.map((c) => c.id)).toEqual(['KEEP'])
    // The ledger PERSISTS the sweep (sweptAt line appended).
    const ledgerLines = readFileSync(join(canaryDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(ledgerLines.some((e) => e.kind === 'sweep' && e.canaryId === canaryId)).toBe(true)

    // Now CORRUPT the ledger (tamper a line) -> scoreCanaries refuses.
    const ledgerPath = join(canaryDir, 'ledger.jsonl')
    const corrupt = readFileSync(ledgerPath, 'utf8').replace('"kind":"plant"', '"kind":"TAMPERED"')
    writeFileSync(ledgerPath, corrupt)
    const scored = scoreCanaries({ divergences: [], dirs: { canaryDir } })
    expect(scored).toEqual({ ok: false, reason: 'chain-broken' })
  })
})
