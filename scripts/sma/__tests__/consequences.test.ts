/**
 * Tests for scripts/sma/lib/consequences.mjs (Phase 9.2 Plan 08 — D-9.2-12).
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
  graderContradictionEvent,
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

describe('consequences.mjs — the law brain (9.2-08 task 1)', () => {
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

  // Placeholder to keep the marker `openBlocks` referenced in this describe.
  it('Test 5b: openBlocks on a missing ledger dir is honest-empty (fail-open C9)', () => {
    const res = openBlocks({ calibrationDir: join(dir, 'does-not-exist') })
    expect(res.blocks).toEqual([])
    expect(res.warns).toEqual([])
    expect(res.corrupt).toBe(0)
  })

  it('Test 6: openRollbackCandidate is create-only, sha-validated, never throws', () => {
    const good = 'a'.repeat(40)
    const calls: string[][] = []
    const spy = (args: string[]) => {
      calls.push(args)
      return ''
    }
    const ok = openRollbackCandidate({ slug: 'plan/9.2 08!', sha: good, execGit: spy })
    expect(ok.created).toBe(true)
    expect(calls).toHaveLength(1)
    const [verb, ref, sha, oldval] = calls[0]
    expect(verb).toBe('update-ref')
    expect(ref).toBe('refs/heads/sma/rollback-candidate/plan_9.2_08_')
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

// ── grader-contradiction is class-A (9.4-02) ────────────────────────────────

describe('grader-contradiction class-A clause (9.4-02 task 2)', () => {
  /** A scored (contradicted) grader-verdict record, as scoreGraderVerdicts emits. */
  function contradicted(over: Record<string, unknown> = {}) {
    return {
      kind: 'grader-verdict',
      domain: 'sma.verification',
      id: 'P',
      planId: 'P',
      verdict: 'satisfied',
      judgeModelId: 'judge-x',
      source: 'blind-verify',
      at: '2026-07-08T00:00:00.000Z',
      outcome: 'contradicted',
      ...over,
    }
  }

  it('Test 1: a grader-contradiction event classifies class-A via the existing domain boundary', () => {
    const ev = graderContradictionEvent(contradicted())
    expect(ev.type).toBe('grader-contradiction')
    expect(ev.domain).toBe('sma.verification')
    expect(ev.judgeModelId).toBe('judge-x')
    expect(classifyEvent(ev)).toBe('A')
    // sma.verification is ALREADY in CLASS_A_DOMAINS — no new domain added.
    expect(CLASS_A_DOMAINS).toContain('sma.verification')
    // a grader-contradiction outside a class-A domain is only a warn (boundary is real).
    expect(classifyEvent({ type: 'grader-contradiction', domain: 'sma.perf' })).toBe('B')
  })

  it('Test 2: an open grader-contradiction blocks (openBlocks) and survives an unrelated disposition', () => {
    const calibrationDir = join(dir, 'calibration')
    const ev = graderContradictionEvent(contradicted())
    appendVerdict(ev, { calibrationDir })
    // an unrelated trust miss too
    appendVerdict({ id: 'P-OTHER', verdict: 'miss', domain: 'sma.receipts', scoredAt: '2026-07-08T05:00:00Z' }, { calibrationDir })

    const before = openBlocks({ calibrationDir })
    expect(before.blocks).toHaveLength(2)
    // dispose the OTHER event → the grader-contradiction still blocks.
    recordDisposition(
      { eventKey: 'P-OTHER@2026-07-08T05:00:00Z', disposition: 'accept', reason: 'x', by: 'founder', domain: 'sma.receipts' },
      { calibrationDir },
    )
    const after = openBlocks({ calibrationDir })
    expect(after.blocks).toHaveLength(1)
    expect(after.blocks[0].type).toBe('grader-contradiction')
  })

  it('Test 3: only a founder disposition against the eventKey clears it — nothing else does', () => {
    const calibrationDir = join(dir, 'calibration')
    const ev = graderContradictionEvent(contradicted())
    appendVerdict(ev, { calibrationDir })
    const open = openBlocks({ calibrationDir })
    expect(open.blocks).toHaveLength(1)
    const key = open.blocks[0].eventKey

    // a disposition against a DIFFERENT key does not clear it.
    recordDisposition({ eventKey: 'WRONG@0', disposition: 'accept', reason: 'r', by: 'founder', domain: 'sma.verification' }, { calibrationDir })
    expect(openBlocks({ calibrationDir }).blocks).toHaveLength(1)

    // the correct founder disposition clears it.
    recordDisposition({ eventKey: key, disposition: 'fix-forward', reason: 'r', by: 'founder', domain: 'sma.verification' }, { calibrationDir })
    expect(openBlocks({ calibrationDir }).blocks).toHaveLength(0)
  })

  it('Test 4: the same contradiction reported twice yields ONE open block (eventKey dedupe)', () => {
    const calibrationDir = join(dir, 'calibration')
    // derived-from-record timestamp → identical eventKey on both events
    const ev1 = graderContradictionEvent(contradicted())
    const ev2 = graderContradictionEvent(contradicted())
    expect(ev1.scoredAt).toBe(ev2.scoredAt) // deterministic key, not wall-clock
    appendVerdict(ev1, { calibrationDir })
    appendVerdict(ev2, { calibrationDir })
    const res = openBlocks({ calibrationDir })
    expect(res.blocks).toHaveLength(1)
  })
})

// ── Task 3: CLI surface — preship (auto-block) + disposition (founder gate) ──
// These shell out to the real cli.mjs with a temp SMA root (harness posture).

import { readJournal } from '../lib/journal.mjs'

const CLI = join(__dirname, '..', 'cli.mjs')
function runCli(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }) as string
    return { code: 0, stdout }
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: (e.stdout as string) || '' }
  }
}

/** The last non-empty stdout line (the scorer/count contract). */
function lastLine(stdout: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

describe('preship + disposition CLI (9.2-08 task 3)', () => {
  it('Test 1: preship exits 0 on empty ledger, 1 on an undispositioned divergence, 0 after disposition', () => {
    const smaRoot = join(dir, '.sma')
    const calibrationDir = join(smaRoot, 'calibration')
    const env = { SMA_ROOT_OVERRIDE: smaRoot }

    // Empty ledger → clean, exit 0.
    expect(runCli(['preship'], env).code).toBe(0)

    // Plant an undispositioned divergence → exit 1, block-list names key + class.
    appendVerdict({ id: 'D-1', verdict: 'divergence', domain: 'sma.receipts', at: 'ts1' }, { calibrationDir })
    const blocked = runCli(['preship'], env)
    expect(blocked.code).toBe(1)
    expect(blocked.stdout).toContain('D-1@ts1')
    expect(blocked.stdout).toMatch(/class A/i)

    // Founder disposition clears it → exit 0.
    const disp = runCli(['disposition', 'D-1@ts1', '--verdict', 'accept', '--reason', 'known-issue', '--yes'], env)
    expect(disp.code).toBe(0)
    expect(runCli(['preship'], env).code).toBe(0)
  })

  it('Test 2: preship --count prints the open class-A count as the last line, exit 0', () => {
    const smaRoot = join(dir, '.sma')
    const calibrationDir = join(smaRoot, 'calibration')
    const env = { SMA_ROOT_OVERRIDE: smaRoot }
    appendVerdict({ id: 'D-1', verdict: 'divergence', domain: 'sma.receipts', at: 'ts1' }, { calibrationDir })
    const res = runCli(['preship', '--count'], env)
    expect(res.code).toBe(0)
    expect(lastLine(res.stdout)).toBe('1')
  })

  it('Test 3: preship --selftest prints 2, exits 0, never touches the real ledger', () => {
    const smaRoot = join(dir, '.sma')
    const calibrationDir = join(smaRoot, 'calibration')
    const env = { SMA_ROOT_OVERRIDE: smaRoot }
    const res = runCli(['preship', '--selftest'], env)
    expect(res.code).toBe(0)
    expect(lastLine(res.stdout)).toBe('2')
    // The real ledger dir was never created by the throwaway self-test.
    expect(existsSync(calibrationDir)).toBe(false)
  })

  it('Test 4: disposition refuses (exit 1, zero writes) without --yes or --reason; writes with both', () => {
    const smaRoot = join(dir, '.sma')
    const calibrationDir = join(smaRoot, 'calibration')
    const journalDir = join(smaRoot, 'journal')
    const env = { SMA_ROOT_OVERRIDE: smaRoot }

    // Without --yes → refuse, nothing written.
    expect(runCli(['disposition', 'E@1', '--verdict', 'accept', '--reason', 'r'], env).code).toBe(1)
    expect(existsSync(calibrationDir)).toBe(false)

    // Without --reason → refuse, nothing written.
    expect(runCli(['disposition', 'E@1', '--verdict', 'accept', '--yes'], env).code).toBe(1)
    expect(existsSync(calibrationDir)).toBe(false)

    // With both → one disposition line + one journal event.
    expect(runCli(['disposition', 'E@1', '--verdict', 'accept', '--reason', 'r', '--yes'], env).code).toBe(0)
    const led = readLedger({ calibrationDir })
    expect(led.records.filter((r: any) => r.kind === 'disposition')).toHaveLength(1)
    const jrn = readJournal({ journalDir })
    expect(jrn.events.filter((e: any) => e.type === 'disposition')).toHaveLength(1)
  })
})
