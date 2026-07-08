/**
 * Tests for scripts/sma/lib/consequences.mjs (Phase 49.2 Plan 08 — D-49.2-12).
 *
 * Consequences-as-LAW: the deterministic brain that turns a recorded class-A
 * event into a ship BLOCK.
 *
 * Task 1 (lib — DI unit tests):
 *   - Test 1: validateConsequence field contract + class {A,B} guard.
 *   - Test 2: parseConsequences round-trips a two-entry block; empty on absence;
 *     the predict.test.ts parser generalization stays non-breaking.
 *   - Test 3: classifyEvent — divergence/trust-miss = A; other miss = B;
 *     escalate-only (downgrade of a trust-domain miss is IGNORED).
 *   - Test 4: openBlocks partitions A blocks vs B warns; a disposition clears
 *     exactly its own block.
 *   - Test 5: recordDisposition appends one JSONL line; hitRate is unchanged
 *     (dispositions carry no verdict); a corrupt line is skipped, never fatal.
 *   - Test 6: openRollbackCandidate is create-only + sha-validated + never throws.
 *
 * Task 3 (CLI surface) tests live at the bottom of this file (preship/disposition).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  parseConsequences,
  validateConsequence,
  classifyEvent,
  eventKey,
  openBlocks,
  recordDisposition,
  openRollbackCandidate,
  CLASS_A_DOMAINS,
} from '../lib/consequences.mjs'
import { appendVerdict, readLedger, hitRate } from '../lib/calibration.mjs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-cons-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

/** Render one consequences entry as frontmatter dash-list YAML lines. */
function entryYaml(overrides: Record<string, string | undefined> = {}): string {
  const e: Record<string, string | undefined> = {
    id: 'CONS-1',
    trigger: '"class-A miss on P1"',
    blocks: '"sma ship for the product repo"',
    until: '"founder disposition recorded"',
    ...overrides,
  }
  const keys = Object.keys(e).filter((k) => e[k] !== undefined)
  return keys.map((k, i) => (i === 0 ? `  - ${k}: ${e[k]}` : `    ${k}: ${e[k]}`)).join('\n') + '\n'
}

/** Write a fixture PLAN.md carrying the given consequences entries. */
function writePlan(entries: string, name = 'PLAN.md'): string {
  const p = join(dir, name)
  writeFileSync(p, `---\nphase: test\nconsequences:\n${entries}---\n\nbody\n`)
  return p
}

describe('consequences.mjs — the law brain (49.2-08 task 1)', () => {
  it('Test 1: validateConsequence rejects missing required fields, guards class {A,B}', () => {
    // Missing `until` → invalid, names the field.
    const noUntil = validateConsequence({ id: 'C', trigger: 't', blocks: 'b' })
    expect(noUntil.valid).toBe(false)
    expect(noUntil.missing).toContain('until')

    // Full entry → valid; optional rationale + class accepted.
    const full = validateConsequence({
      id: 'C',
      trigger: 't',
      blocks: 'b',
      until: 'u',
      rationale: 'because',
      class: 'a',
    })
    expect(full.valid).toBe(true)

    // class outside {A,B} (case-insensitive) → error.
    const badClass = validateConsequence({ id: 'C', trigger: 't', blocks: 'b', until: 'u', class: 'C' })
    expect(badClass.valid).toBe(false)
    expect(badClass.errors.join(' ')).toMatch(/class/)

    // empty required string counts as missing.
    const empty = validateConsequence({ id: '', trigger: 't', blocks: 'b', until: 'u' })
    expect(empty.missing).toContain('id')
  })

  it('Test 2: parseConsequences round-trips two entries verbatim; empty on absence', () => {
    const p = writePlan(entryYaml({ id: 'CONS-A' }) + entryYaml({ id: 'CONS-B', class: 'A' }))
    const { consequences } = parseConsequences(p)
    expect(consequences).toHaveLength(2)
    expect(consequences[0].id).toBe('CONS-A')
    expect(consequences[0].trigger).toBe('class-A miss on P1')
    expect(consequences[0].blocks).toBe('sma ship for the product repo')
    expect(consequences[0].until).toBe('founder disposition recorded')
    expect(consequences[1].id).toBe('CONS-B')
    expect(consequences[1].class).toBe('A')

    // A plan without the block returns an honest empty array, never a throw.
    const bare = join(dir, 'BARE-PLAN.md')
    writeFileSync(bare, `---\nphase: test\n---\n\nbody\n`)
    expect(parseConsequences(bare).consequences).toEqual([])

    // An injected readFn is honored (lint uses this to avoid a second read).
    const viaRead = parseConsequences('ignored', { readFn: () => readFileSync(p, 'utf8') })
    expect(viaRead.consequences).toHaveLength(2)
  })

  it('Test 3: classifyEvent is total, deterministic, and downgrade-proof', () => {
    expect(classifyEvent({ verdict: 'divergence' })).toBe('A')
    expect(classifyEvent({ verdict: 'miss', domain: 'sma.receipts' })).toBe('A')
    expect(classifyEvent({ verdict: 'miss', domain: 'sma.perf' })).toBe('B')
    // escalation allowed: a non-trust miss declared class A becomes A.
    expect(classifyEvent({ verdict: 'miss', domain: 'sma.perf', class: 'A' })).toBe('A')
    // downgrade IGNORED: a trust-domain miss declared class B stays A.
    expect(classifyEvent({ verdict: 'miss', domain: 'sma.subagents', class: 'B' })).toBe('A')
    expect(classifyEvent({ verdict: 'hit' })).toBeNull()
    expect(classifyEvent({ kind: 'disposition', ref: 'x' })).toBeNull()
    // every trust domain is class A on a miss.
    for (const d of CLASS_A_DOMAINS) {
      expect(classifyEvent({ verdict: 'miss', domain: d })).toBe('A')
    }
  })

  it('Test 4: openBlocks returns 2 blocks + 1 warn; a disposition clears exactly one', () => {
    const calibrationDir = join(dir, 'calibration')
    const trustMiss = { id: 'P-A', verdict: 'miss', domain: 'sma.subagents', scoredAt: '2026-07-08T00:00:00Z' }
    const divergence = { id: 'D-1', verdict: 'divergence', domain: 'sma.receipts', at: '2026-07-08T01:00:00Z' }
    appendVerdict(trustMiss, { calibrationDir })
    appendVerdict(divergence, { calibrationDir })
    appendVerdict({ id: 'P-B', verdict: 'miss', domain: 'sma.perf', scoredAt: '2026-07-08T02:00:00Z' }, { calibrationDir })
    appendVerdict({ id: 'P-C', verdict: 'hit', domain: 'sma.perf', scoredAt: '2026-07-08T03:00:00Z' }, { calibrationDir })

    const before = openBlocks({ calibrationDir })
    expect(before.blocks).toHaveLength(2)
    expect(before.warns).toHaveLength(1)

    // Disposition the trust miss → its block clears; the divergence still blocks.
    recordDisposition(
      { eventKey: eventKey(trustMiss), disposition: 'accept', reason: 'known slow host', by: 'founder', domain: 'sma.subagents' },
      { calibrationDir },
    )
    const after = openBlocks({ calibrationDir })
    expect(after.blocks).toHaveLength(1)
    expect(after.blocks[0].id).toBe('D-1')
  })

  it('Test 5: recordDisposition appends one line; hitRate unchanged; corrupt line skipped', () => {
    const calibrationDir = join(dir, 'calibration')
    appendVerdict({ id: 'P1', verdict: 'hit', domain: 'sma.perf', scoredAt: 't1' }, { calibrationDir })
    appendVerdict({ id: 'P2', verdict: 'miss', domain: 'sma.perf', scoredAt: 't2' }, { calibrationDir })

    const rateBefore = hitRate(readLedger({ calibrationDir, domain: 'sma.perf' }).records)
    recordDisposition(
      { eventKey: 'P2@t2', disposition: 'fix-forward', reason: 'r', by: 'founder', domain: 'sma.perf' },
      { calibrationDir },
    )
    const parsed = readLedger({ calibrationDir, domain: 'sma.perf' })
    const rateAfter = hitRate(parsed.records)
    // dispositions carry no verdict → hitRate identical before/after.
    expect(rateAfter).toEqual(rateBefore)
    expect(parsed.records.filter((r: any) => r.kind === 'disposition')).toHaveLength(1)

    // A corrupt ledger line is skipped-and-counted, never fatal.
    const file = join(calibrationDir, 'sma.perf.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8') + 'THIS IS NOT JSON\n')
    const corruptRead = readLedger({ calibrationDir, domain: 'sma.perf' })
    expect(corruptRead.corrupt).toBe(1)
    expect(() => openBlocks({ calibrationDir })).not.toThrow()
  })

  it('Test 6: openRollbackCandidate is create-only, sha-validated, never throws', () => {
    const good = 'a'.repeat(40)
    const calls: string[][] = []
    const spy = (args: string[]) => {
      calls.push(args)
      return ''
    }
    const ok = openRollbackCandidate({ slug: 'plan/49.2 08!', sha: good, execGit: spy })
    expect(ok.created).toBe(true)
    expect(calls).toHaveLength(1)
    const [verb, ref, sha, oldval] = calls[0]
    expect(verb).toBe('update-ref')
    expect(ref).toBe('refs/heads/sma/rollback-candidate/plan_49.2_08_')
    expect(sha).toBe(good)
    expect(oldval).toBe('0'.repeat(40)) // create-only: refuses if the ref exists

    // Non-40-hex sha → refused BEFORE any git call (spy never invoked).
    calls.length = 0
    const bad = openRollbackCandidate({ slug: 's', sha: 'deadbeef', execGit: spy })
    expect(bad.created).toBe(false)
    expect(calls).toHaveLength(0)

    // An execGit throw (ref exists) → {created:false, existed:true}, never throws.
    const thrower = () => {
      throw new Error('fatal: ref already exists')
    }
    const existed = openRollbackCandidate({ slug: 's', sha: good, execGit: thrower })
    expect(existed.created).toBe(false)
    expect(existed.existed).toBe(true)
  })
})
