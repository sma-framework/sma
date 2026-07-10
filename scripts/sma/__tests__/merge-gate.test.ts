/**
 * Tests for scripts/sma/lib/merge-gate.mjs (Phase 9.3 Plan 15).
 *
 * 9.3-15 (D-9.3-24c/d/e/f) — the serialized merge gate + the verified-live-only
 * enforcing-scope predicate.
 *
 * Task 1 — merge-claim triplet + the `sma merge` ritual:
 *   - Test 1: the merge-claim triplet mirrors the push-claim (acquire/second-fails/check/release)
 *   - Test 2: runMerge ritual order — acquire -> local merge -> tests-on-the-MERGE-RESULT -> receipt -> release
 *   - Test 3: a concurrent merge -> SOFT-deny with an override (never a hard block / throw)
 *   - Test 4: runMerge issues NO push / deploy subcommand (local integration only)
 *   - Test 5: tests-fail -> {merged:true, testsPassed:false} + an HONEST failure receipt (never a false green)
 *   - Test 6: fail-open — an execGit/runTests throw -> {ok:false} + the slot is released (never wedged)
 *
 * Task 2 — enforcing scopes (verified-live-only soft-deny + the opt-in PRE_CHECKS stream):
 *   - Test 7: enforceScope soft-denies ONLY a verified-LIVE claim; stale -> warn; none -> allow
 *   - Test 8: the enforce stream is opt-in default-off (no-op) — soft-denies only with SMA_ENFORCE_SCOPES set
 *   - Test 9: a soft-deny carries an override token; the stream is mayDeny:true (never a hard block)
 *   - Test 10: fail-open — an injected error -> allow; SMA_ENFORCE_SCOPES_DISABLE short-circuits before evidence
 *   - Test 11: founder word wins — a cooling-down / force-cleared scope is NEVER enforced
 *
 * A DI execGit records every args array so tests never touch git and can assert the
 * no-push invariant. Claims + journal go to per-test temp dirs (the real .sma/ is
 * NEVER touched, no real merge is ever run).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireMergeClaim,
  releaseMergeClaim,
  checkMergeClaim,
  runMerge,
  enforceScope,
  ENFORCE_OVERRIDE_HINT,
} from '../lib/merge-gate.mjs'
import { readJournal } from '../lib/journal.mjs'
import { verifyClaimEvidence } from '../lib/collision.mjs'
import { PRE_CHECKS } from '../lib/pre.mjs'

let claimsDir: string
let journalDir: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'sma-merge-gate-'))
  claimsDir = join(base, 'claims')
  journalDir = join(base, 'journal')
})

afterEach(() => {
  try {
    rmSync(join(claimsDir, '..'), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/** makeExecGit — a DI git runner. Records every {args, cwd}; rev-parse returns a fixed sha. */
function makeExecGit(opts: { throwOn?: string; resultSha?: string } = {}) {
  const calls: Array<{ args: string[]; cwd: string | undefined }> = []
  const runner = (args: string[], o: { cwd?: string } = {}) => {
    calls.push({ args, cwd: o.cwd })
    if (opts.throwOn && args[0] === opts.throwOn) throw new Error(`git ${opts.throwOn} failed`)
    if (args[0] === 'rev-parse') return `${opts.resultSha ?? 'MERGE_RESULT_SHA'}\n`
    return ''
  }
  ;(runner as any).calls = calls
  return runner as ((args: string[], o?: { cwd?: string }) => string) & { calls: typeof calls }
}

describe('9.3-15 Task 1 — merge-claim triplet + the sma merge ritual', () => {
  it('Test 1: the merge-claim triplet mirrors the push-claim (acquire/second-fails/check/release)', () => {
    const a = acquireMergeClaim({ by: 'T-a', branch: 'sma-wt/x', claimsDir, journalDir })
    expect(a.acquired).toBe(true)

    // a SECOND concurrent acquire returns {acquired:false, holder} — NOT a throw.
    const b = acquireMergeClaim({ by: 'T-b', branch: 'sma-wt/y', claimsDir, journalDir })
    expect(b.acquired).toBe(false)
    expect(b.holder && (b.holder as any).by).toBe('T-a')

    // checkMergeClaim reports the current holder WITHOUT mutating.
    const chk = checkMergeClaim({ claimsDir })
    expect(chk.live).toBe(true)
    expect(chk.who).toBe('T-a')
    expect(chk.branch).toBe('sma-wt/x')
    // still held after a read — no mutation.
    expect(acquireMergeClaim({ by: 'T-c', claimsDir, journalDir }).acquired).toBe(false)

    const rel = releaseMergeClaim({ by: 'T-a', claimsDir, journalDir })
    expect(rel.released).toBe(true)
    // after release, a fresh acquire wins.
    expect(acquireMergeClaim({ by: 'T-d', claimsDir, journalDir }).acquired).toBe(true)
  })

  it('Test 2: runMerge order — acquire -> local merge -> tests-on-the-MERGE-RESULT -> receipt -> release', () => {
    const execGit = makeExecGit()
    let testedSha: string | null = null
    const runTests = ({ resultSha }: { resultSha: string }) => {
      testedSha = resultSha
      return { passed: true }
    }
    const res = runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests, claimsDir, journalDir, cwd: '/repo' }) as any
    expect(res.merged).toBe(true)
    expect(res.testsPassed).toBe(true)

    // ritual order: merge BEFORE the result-sha read.
    const mergeIdx = execGit.calls.findIndex((c) => c.args[0] === 'merge')
    const revIdx = execGit.calls.findIndex((c) => c.args[0] === 'rev-parse')
    expect(mergeIdx).toBeGreaterThanOrEqual(0)
    expect(revIdx).toBeGreaterThan(mergeIdx)
    // tests ran on the MERGE RESULT, not on either branch alone.
    expect(testedSha).toBe('MERGE_RESULT_SHA')
    // every git call carried an explicit cwd (no CWD teleport).
    for (const c of execGit.calls) expect(c.cwd).toBe('/repo')

    // a receipt was journaled.
    const j = readJournal({ journalDir })
    const receipt = j.events.find((e: any) => e.type === 'merge')
    expect(receipt).toBeTruthy()
    expect((receipt as any).detail.branch).toBe('sma-wt/x')
    expect((receipt as any).detail.testsPassed).toBe(true)

    // slot released — a subsequent acquire wins.
    expect(acquireMergeClaim({ by: 'T-b', claimsDir, journalDir }).acquired).toBe(true)
  })

  it('Test 3: a concurrent merge -> SOFT-deny with an override (never a hard block / throw)', () => {
    // another terminal holds the merge slot.
    acquireMergeClaim({ by: 'T-other', branch: 'sma-wt/held', claimsDir, journalDir })
    const execGit = makeExecGit()
    const res = runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests: () => ({ passed: true }), claimsDir, journalDir }) as any
    expect(res.merged).toBe(false)
    expect(res.softDenied).toBe(true)
    expect(typeof res.override).toBe('string')
    expect(res.override.length).toBeGreaterThan(0)
    // it never merged — no git call happened at all.
    expect(execGit.calls.length).toBe(0)
  })

  it('Test 4: runMerge issues NO push / deploy subcommand (local integration only)', () => {
    const execGit = makeExecGit()
    const res = runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests: () => ({ passed: true }), claimsDir, journalDir, cwd: '/repo' }) as any
    expect(res.merged).toBe(true)
    const verbs = execGit.calls.map((c) => c.args[0])
    expect(verbs).not.toContain('push')
    expect(execGit.calls.every((c) => !c.args.includes('push'))).toBe(true)
    // only local read/merge subcommands.
    for (const v of verbs) expect(['merge', 'rev-parse']).toContain(v)
  })

  it('Test 5: tests-fail -> {merged:true, testsPassed:false} + an HONEST failure receipt', () => {
    const execGit = makeExecGit()
    const res = runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit, runTests: () => ({ passed: false }), claimsDir, journalDir }) as any
    expect(res.merged).toBe(true)
    expect(res.testsPassed).toBe(false)
    // the receipt records the FAILURE — never a false green.
    const j = readJournal({ journalDir })
    const receipt = j.events.find((e: any) => e.type === 'merge')
    expect((receipt as any).detail.testsPassed).toBe(false)
    // slot released even on a red merge.
    expect(acquireMergeClaim({ by: 'T-b', claimsDir, journalDir }).acquired).toBe(true)
  })

  it('Test 6: fail-open — an execGit throw -> {ok:false} + the slot is released (never wedged)', () => {
    const throwGit = makeExecGit({ throwOn: 'merge' })
    const res = runMerge({ branch: 'sma-wt/x', by: 'T-a', execGit: throwGit, runTests: () => ({ passed: true }), claimsDir, journalDir }) as any
    expect(res.ok).toBe(false)
    expect(typeof res.message).toBe('string')
    // the held slot was released by the fail-open wrapper — a subsequent acquire wins.
    const again = acquireMergeClaim({ by: 'T-b', claimsDir, journalDir })
    expect(again.acquired).toBe(true)
  })
})

/**
 * makeCtx — a minimal hand-built pre-stream ctx for the enforce stream. deps.mergeGate is
 * the real module; deps.collision.verifyClaimEvidence is the real predicate; deps.fingerprint
 * is a stub whose overlapInjection returns the injected overlaps (or throws when asked).
 */
function makeCtx(opts: { env?: Record<string, string>; overlaps?: any[]; overlapThrows?: boolean } = {}) {
  const overlaps = opts.overlaps ?? []
  return {
    env: opts.env ?? {},
    toolName: 'Edit',
    toolInput: { file_path: 'src/x.ts' },
    sessions: [],
    identity: { terminalId: 'self' },
    repoRoot: '/repo',
    now: () => Date.now(),
    deps: {
      mergeGate: { enforceScope },
      collision: { verifyClaimEvidence },
      fingerprint: {
        overlapInjection: () => {
          if (opts.overlapThrows) throw new Error('overlap boom')
          return overlaps
        },
      },
    },
  } as any
}

describe('9.3-15 Task 2 — enforcing scopes (verified-live-only soft-deny + opt-in stream)', () => {
  it('Test 7: enforceScope soft-denies ONLY a verified-LIVE claim; stale -> warn; none -> allow', () => {
    // dirty scope (no post-renew commit) -> verifyClaimEvidence LIVE -> soft-deny + override.
    const live = enforceScope({ foreignClaim: { by: 'T-x' }, evidence: { scopeDirtyVsHead: true }, env: {}, verifyClaimEvidence })
    expect(live.action).toBe('soft-deny')
    expect(typeof live.override).toBe('string')
    expect((live.override as string).length).toBeGreaterThan(0)

    // clean scope + a post-renew in-scope commit -> STALE -> WARN-only (never soft-deny).
    const stale = enforceScope({
      foreignClaim: { by: 'T-x' },
      evidence: { scopeDirtyVsHead: false, commitInScopeAfterRenew: 'abcdef1' },
      env: {},
      verifyClaimEvidence,
    })
    expect(stale.action).toBe('warn')

    // no foreign claim -> allow.
    const none = enforceScope({ foreignClaim: null, env: {}, verifyClaimEvidence })
    expect(none.action).toBe('allow')
  })

  it('Test 8: the enforce stream is opt-in default-off (no-op) — soft-denies only with SMA_ENFORCE_SCOPES', async () => {
    const stream = PRE_CHECKS.find((s: any) => s.id === 'enforce') as any
    expect(stream).toBeTruthy()
    expect(stream.mayDeny).toBe(true)
    expect(stream.killSwitchEnv).toBe('SMA_ENFORCE_SCOPES_DISABLE')

    // opt-in OFF -> strict no-op even WITH a live overlap.
    const off = await stream.run(makeCtx({ env: {}, overlaps: [{ terminalId: 'T-x' }] }))
    expect(off.deny).toBeFalsy()
    expect(off.warns).toEqual([])

    // opt-in ON + a verified-live overlap -> soft-deny.
    const on = await stream.run(makeCtx({ env: { SMA_ENFORCE_SCOPES: '1' }, overlaps: [{ terminalId: 'T-x' }] }))
    expect(on.deny).toBeTruthy()
  })

  it('Test 9: a soft-deny carries an override token; the stream is mayDeny:true (never a hard block)', async () => {
    const stream = PRE_CHECKS.find((s: any) => s.id === 'enforce') as any
    const on = await stream.run(makeCtx({ env: { SMA_ENFORCE_SCOPES: '1' }, overlaps: [{ terminalId: 'T-x' }] }))
    expect(on.deny).toBeTruthy()
    // the deny text carries the override token — so it can never block real work.
    expect(String(on.deny.text)).toContain(ENFORCE_OVERRIDE_HINT.slice(0, 20))
    // the enforce stream is a SOFT-deny tier (mayDeny:true); gates (the security guard tier) is separate.
    expect(stream.mayDeny).toBe(true)
    const gates = PRE_CHECKS.find((s: any) => s.id === 'gates')
    expect(gates).toBeTruthy()
    expect((gates as any).id).not.toBe(stream.id)
  })

  it('Test 10: fail-open — an injected error -> allow; SMA_ENFORCE_SCOPES_DISABLE short-circuits before evidence', async () => {
    // verifyClaimEvidence throws -> enforceScope returns allow (never a deny on error).
    const errored = enforceScope({
      foreignClaim: { by: 'T-x' },
      evidence: {},
      env: {},
      verifyClaimEvidence: () => {
        throw new Error('evidence boom')
      },
    })
    expect(errored.action).toBe('allow')

    // DISABLE short-circuits BEFORE any evidence read.
    let read = false
    const disabled = enforceScope({
      foreignClaim: { by: 'T-x' },
      evidence: {},
      env: { SMA_ENFORCE_SCOPES_DISABLE: '1' },
      verifyClaimEvidence: () => {
        read = true
        return { live: true }
      },
    })
    expect(disabled.action).toBe('allow')
    expect(read).toBe(false)

    // stream fail-open: an overlapInjection that throws -> {warns:[]}, no deny.
    const stream = PRE_CHECKS.find((s: any) => s.id === 'enforce') as any
    const r = await stream.run(makeCtx({ env: { SMA_ENFORCE_SCOPES: '1' }, overlapThrows: true }))
    expect(r.deny).toBeFalsy()
    expect(r.warns).toEqual([])
  })

  it('Test 11: founder word wins — a cooling-down / force-cleared scope is NEVER enforced', () => {
    const cooling = enforceScope({
      foreignClaim: { by: 'T-x' },
      evidence: { scopeDirtyVsHead: true }, // would be LIVE...
      env: {},
      verifyClaimEvidence,
      coolingDown: true, // ...but a cooling-down scope is never enforced (D-9-09).
    })
    expect(cooling.action).toBe('warn')
    expect(cooling.action).not.toBe('soft-deny')
  })
})
