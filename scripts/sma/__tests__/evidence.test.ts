/**
 * Tests for scripts/sma/lib/evidence.mjs + the 49.2-07 risky-op gates in gates.mjs
 * (Phase 49.2 Plan 07, Task 3 — D-49.2-11).
 *
 * Burden of proof before the hook yields: a risky op (force-push, allowlist-edit,
 * foreign-claim-clear) carries an append-only evidence record naming the reason + the
 * verifications performed. GATE-FORCEPUSH + GATE-ALLOWLIST WARN by default; their
 * DORMANT soft-deny tier is satisfied only by a fresh evidence record. No delete path;
 * fail-open; hard-deny stays the security guard's alone.
 *
 *   - Test 1: writeEvidence validates op/reason/checks; anything less writes nothing.
 *   - Test 2: hasFreshEvidence — TTL + target discrimination; missing dir → false.
 *   - Test 3: GATE-FORCEPUSH matches force-push, WARN names the evidence path, armed
 *     soft-deny satisfied ONLY by fresh evidence.
 *   - Test 4: GATE-ALLOWLIST matches a predict.mjs SAFE_COMMAND edit; killEnv + dormant
 *     soft-deny.
 *   - Test 5: fail-open — a missing evidence dir never throws; killEnv silences.
 *   - Test 6: evidenceStats coverage; no risky-op events → 100.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeEvidence, hasFreshEvidence, evidenceStats, RISKY_OPS } from '../lib/evidence.mjs'
import { checkEvent } from '../lib/gates.mjs'
import { appendEvent } from '../lib/journal.mjs'

const REPO_ROOT = 'C:\\Users\\dev\\projects\\example-app'
const abs = (rel: string) => REPO_ROOT + '\\' + rel.replace(/\//g, '\\')
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
const edit = (rel: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Edit', tool_input: { file_path: abs(rel), ...extra } })

let evidenceDir: string
let journalDir: string

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), 'sma-evidence-'))
  journalDir = mkdtempSync(join(tmpdir(), 'sma-evidence-jrnl-'))
})
afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true })
  rmSync(journalDir, { recursive: true, force: true })
})

describe('evidence.mjs + risky-op gates — burden of proof', () => {
  it('Test 1 — writeEvidence validates op/reason/checks; anything less writes nothing', () => {
    // valid
    const ok = writeEvidence(
      { op: 'force-push', target: 'origin main', reason: 'rebased hotfix', checks: ['ran tests', 'reviewed diff'], actor: 'term-A' },
      { evidenceDir },
    )
    expect(ok.ok).toBe(true)
    expect(readdirSync(evidenceDir).filter((f) => f.endsWith('.json')).length).toBe(1)

    // op not in RISKY_OPS → rejected, nothing written
    const badOp = writeEvidence({ op: 'rm-rf', target: 't', reason: 'r', checks: ['c'] }, { evidenceDir })
    expect(badOp.ok).toBe(false)
    expect(badOp.missing.some((m: string) => /op/.test(m))).toBe(true)

    // empty checks → rejected
    const noChecks = writeEvidence({ op: 'allowlist-edit', target: 't', reason: 'r', checks: [] }, { evidenceDir })
    expect(noChecks.ok).toBe(false)

    // empty reason → rejected
    const noReason = writeEvidence({ op: 'force-push', target: 't', reason: '  ', checks: ['c'] }, { evidenceDir })
    expect(noReason.ok).toBe(false)

    // still exactly ONE file (the rejected ones wrote nothing)
    expect(readdirSync(evidenceDir).filter((f) => f.endsWith('.json')).length).toBe(1)
    expect(RISKY_OPS).toContain('foreign-claim-clear')
  })

  it('Test 2 — hasFreshEvidence: TTL + target discrimination; missing dir → false', () => {
    const now = 1_000_000
    writeEvidence({ op: 'force-push', target: 'origin main', reason: 'r', checks: ['c'] }, { evidenceDir, now })

    // matching op+target within TTL → true
    expect(hasFreshEvidence({ op: 'force-push', target: 'origin main', maxAgeMs: 10_000 }, { evidenceDir, now: now + 5_000 })).toBe(true)
    // stale (past TTL) → false
    expect(hasFreshEvidence({ op: 'force-push', target: 'origin main', maxAgeMs: 10_000 }, { evidenceDir, now: now + 20_000 })).toBe(false)
    // wrong target → false
    expect(hasFreshEvidence({ op: 'force-push', target: 'origin other', maxAgeMs: 10_000 }, { evidenceDir, now: now + 5_000 })).toBe(false)
    // missing dir → false, never throws
    expect(hasFreshEvidence({ op: 'force-push', target: 'origin main' }, { evidenceDir: join(evidenceDir, 'nope') })).toBe(false)
  })

  it('Test 3 — GATE-FORCEPUSH: WARN names the evidence path; armed soft-deny needs fresh evidence', () => {
    const forceEvt = bash('git push --force origin main')
    // fires + WARN text names the evidence command
    const warned = checkEvent({ evt: forceEvt, root: REPO_ROOT, env: {}, seen: {} })
    const w = warned.warns.find((x: any) => x.gateId === 'GATE-FORCEPUSH')
    expect(w).toBeDefined()
    expect(w.text).toMatch(/pnpm sma evidence force-push/)
    // dormant by default → no deny
    expect(warned.deny).toBeFalsy()

    // armed + no evidence → deny
    const denied = checkEvent({ evt: forceEvt, root: REPO_ROOT, env: { SMA_GATE_FORCEPUSH_DENY: '1' }, seen: {}, evidenceDir })
    expect(denied.deny).toBeTruthy()
    expect(denied.deny.gateId).toBe('GATE-FORCEPUSH')

    // armed + fresh evidence for the exact target → allow
    writeEvidence({ op: 'force-push', target: 'origin main', reason: 'r', checks: ['c'] }, { evidenceDir })
    const allowed = checkEvent({ evt: forceEvt, root: REPO_ROOT, env: { SMA_GATE_FORCEPUSH_DENY: '1' }, seen: {}, evidenceDir })
    expect(allowed.deny).toBeFalsy()

    // a plain (non-force) push does NOT fire GATE-FORCEPUSH
    const plain = checkEvent({ evt: bash('git push origin main'), root: REPO_ROOT, env: {}, seen: {} })
    expect(plain.warns.map((x: any) => x.gateId)).not.toContain('GATE-FORCEPUSH')
  })

  it('Test 4 — GATE-ALLOWLIST: matches a predict.mjs SAFE_COMMAND edit; killEnv + dormant deny', () => {
    const allowEdit = edit('scripts/sma/lib/predict.mjs', {
      old_string: 'x',
      new_string: 'export const SAFE_COMMAND_PATTERNS = [/^rmrf/]',
    })
    // fires
    const warned = checkEvent({ evt: allowEdit, root: REPO_ROOT, env: {}, seen: {} })
    expect(warned.warns.map((x: any) => x.gateId)).toContain('GATE-ALLOWLIST')
    // killEnv silences
    const off = checkEvent({ evt: allowEdit, root: REPO_ROOT, env: { SMA_GATE_ALLOWLIST_OFF: '1' }, seen: {} })
    expect(off.warns.map((x: any) => x.gateId)).not.toContain('GATE-ALLOWLIST')
    // an unrelated predict.mjs edit (no SAFE_COMMAND) does NOT fire
    const unrelated = edit('scripts/sma/lib/predict.mjs', { old_string: 'x', new_string: 'const foo = 1' })
    expect(checkEvent({ evt: unrelated, root: REPO_ROOT, env: {}, seen: {} }).warns.map((x: any) => x.gateId)).not.toContain('GATE-ALLOWLIST')

    // armed soft-deny needs fresh evidence
    const denied = checkEvent({ evt: allowEdit, root: REPO_ROOT, env: { SMA_GATE_ALLOWLIST_DENY: '1' }, seen: {}, evidenceDir })
    expect(denied.deny).toBeTruthy()
    writeEvidence({ op: 'allowlist-edit', target: 'scripts/sma/lib/predict.mjs', reason: 'r', checks: ['c'] }, { evidenceDir })
    const allowed = checkEvent({ evt: allowEdit, root: REPO_ROOT, env: { SMA_GATE_ALLOWLIST_DENY: '1' }, seen: {}, evidenceDir })
    expect(allowed.deny).toBeFalsy()
  })

  it('Test 5 — fail-open: a missing evidence dir never throws; both new gates still evaluate', () => {
    const forceEvt = bash('git push --force-with-lease origin main')
    let res: any
    expect(() => {
      res = checkEvent({
        evt: forceEvt,
        root: REPO_ROOT,
        env: { SMA_GATE_FORCEPUSH_DENY: '1' },
        seen: {},
        evidenceDir: join(evidenceDir, 'does-not-exist'),
      })
    }).not.toThrow()
    // armed + no readable evidence → deny (no evidence is a clean deny, not a throw)
    expect(res.deny).toBeTruthy()
  })

  it('Test 6 — evidenceStats coverage; no risky-op events → 100', () => {
    // empty set → 100
    expect(evidenceStats({ evidenceDir, journalDir }).coverage).toBe(100)

    // two risky-op events, one with an evidenceId → 50
    appendEvent({ type: 'risky-op', detail: { op: 'force-push', evidenceId: 'ev-1' } }, { terminalId: 'term-A', journalDir })
    appendEvent({ type: 'risky-op', detail: { op: 'force-push', evidenceId: null } }, { terminalId: 'term-A', journalDir })
    const stats = evidenceStats({ evidenceDir, journalDir })
    expect(stats.riskyOps).toBe(2)
    expect(stats.covered).toBe(1)
    expect(stats.coverage).toBe(50)
  })
})
