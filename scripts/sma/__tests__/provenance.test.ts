/**
 * Tests for scripts/sma/lib/claims.mjs (Phase 49 Plan 03, Task 2).
 *
 * R11 + Pattern 4 claim-gate:
 *   - Test 1: two concurrent claimSlot() -> exactly one winner; the loser reads
 *     the winner's provenance holder (mkdirSync WITHOUT recursive -> EEXIST = lost).
 *   - Test 2: provenance.json carries {by, session, at, expectedPrev, reason};
 *     first-ever write has expectedPrev null + reason 'initial', and the scanner
 *     does NOT warn on it (SPEC edge R11).
 *   - Test 3: a deliberately-stale expectedPrev -> scanProvenance() WARN naming
 *     the claim + both values (R11 acceptance).
 *   - Test 4: releaseSlot on a foreign holder refuses without {force:true} (P3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  claimSlot,
  readClaims,
  releaseSlot,
  scanProvenance,
} from '../lib/claims.mjs'

let claimsDir: string

beforeEach(() => {
  claimsDir = mkdtempSync(join(tmpdir(), 'sma-claims-'))
})

afterEach(() => {
  rmSync(claimsDir, { recursive: true, force: true })
})

describe('claimSlot — atomic mkdir gate', () => {
  it('two concurrent claims -> exactly one winner; loser reads holder provenance', async () => {
    const provA = { by: 'alice', session: 's-a', expectedPrev: null, reason: 'initial' }
    const provB = { by: 'bob', session: 's-b', expectedPrev: null, reason: 'initial' }

    const [r1, r2] = await Promise.all([
      Promise.resolve().then(() => claimSlot('mig-070', provA, { claimsDir })),
      Promise.resolve().then(() => claimSlot('mig-070', provB, { claimsDir })),
    ])

    const winners = [r1, r2].filter((r) => r.won)
    const losers = [r1, r2].filter((r) => !r.won)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    // The loser sees the winner's holder stamp (by present).
    expect(losers[0].holder).toBeTruthy()
    expect(losers[0].holder.by).toBe(winners[0] === r1 ? 'alice' : 'bob')
  })
})

describe('provenance stamp', () => {
  it('first write carries {by, session, at, expectedPrev:null, reason:initial} and does NOT warn', () => {
    const res = claimSlot(
      'mig-071',
      { by: 'carol', session: 's-c', expectedPrev: null, reason: 'initial' },
      { claimsDir },
    )
    expect(res.won).toBe(true)

    const provPath = join(claimsDir, 'mig-071', 'provenance.json')
    expect(existsSync(provPath)).toBe(true)
    const prov = JSON.parse(readFileSync(provPath, 'utf8'))
    expect(prov.by).toBe('carol')
    expect(prov.session).toBe('s-c')
    expect(typeof prov.at).toBe('string')
    expect(prov.expectedPrev).toBeNull()
    expect(prov.reason).toBe('initial')

    // initial (expectedPrev null) is exempt from the scanner.
    const warnings = scanProvenance({
      claimsDir,
      expectedResolver: () => 'whatever-actual',
    })
    expect(warnings).toHaveLength(0)
  })
})

describe('scanProvenance — stale expectedPrev', () => {
  it('a stale expectedPrev returns a WARN naming the claim + both values', () => {
    claimSlot(
      'mig-072',
      { by: 'dave', session: 's-d', expectedPrev: 'OLD-HASH', reason: 'update' },
      { claimsDir },
    )

    const warnings = scanProvenance({
      claimsDir,
      expectedResolver: (name) => (name === 'mig-072' ? 'NEW-HASH' : null),
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].claim).toBe('mig-072')
    expect(warnings[0].expected).toBe('OLD-HASH')
    expect(warnings[0].actual).toBe('NEW-HASH')
  })
})

describe('releaseSlot — foreign-claim protection (P3)', () => {
  it('refuses a foreign holder without force; succeeds with force', () => {
    claimSlot(
      'mig-073',
      { by: 'erin', session: 's-e', expectedPrev: null, reason: 'initial' },
      { claimsDir },
    )

    const refused = releaseSlot('mig-073', { by: 'mallory', claimsDir })
    expect(refused.released).toBe(false)
    expect(refused.reason).toBe('foreign')
    expect(existsSync(join(claimsDir, 'mig-073'))).toBe(true)

    // Owner can release.
    const owned = releaseSlot('mig-073', { by: 'erin', claimsDir })
    expect(owned.released).toBe(true)

    // Re-claim then force-release as a foreign holder.
    claimSlot(
      'mig-073',
      { by: 'erin', session: 's-e2', expectedPrev: null, reason: 'initial' },
      { claimsDir },
    )
    const forced = releaseSlot('mig-073', { by: 'mallory', force: true, claimsDir })
    expect(forced.released).toBe(true)
  })

  it('readClaims returns entries with provenance + ageMs, tolerating malformed dirs', () => {
    claimSlot(
      'mig-074',
      { by: 'frank', session: 's-f', expectedPrev: null, reason: 'initial' },
      { claimsDir },
    )
    const claims = readClaims({ claimsDir })
    const entry = claims.find((c) => c.name === 'mig-074')
    expect(entry).toBeTruthy()
    expect(entry.provenance.by).toBe('frank')
    expect(typeof entry.ageMs).toBe('number')
  })
})
