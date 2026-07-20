/**
 * Tests for scripts/sma/lib/airbag.mjs (Phase 9.2 Plan 05, Task 1).
 *
 * The git airbag — a cheap ms-level GATE that snapshots a recovery point BEFORE a
 * destructive git command runs (D-9.2-08):
 *   - Test 1 (matchDestructive): classifies every destructive class + variants; safe
 *     commands (status/add/plain-push/pnpm/non-git rm) return null.
 *   - Test 2 (snapshot, clean tree): pins exactly <id>/head HEAD; receipt shape; every
 *     runner call is a FIXED argv array.
 *   - Test 3 (snapshot, dirty + untracked): stash create pinned; ONE batched hash-object;
 *     single-level mktree with index names; index→path map in the receipt.
 *   - Test 4 (caps): >MAX files / >MAX bytes → truncated; a clean -x → ignoredNotCaptured.
 *   - Test 5 (per-class pins): branch-delete pins the tip; force-push pins the remote; rebase
 *     pins head + current branch.
 *   - Test 6 (fail-open): a throwing runner → {ok:false} and NEVER throws; checkAirbag
 *     degrades to WARN + ok:false receipt, never a deny.
 *   - Test 7 (design-trap spy): the runner is NEVER invoked with the archive verb ('bundle').
 *   - Test 8 (probe): native false today; SMA_NATIVE_CHECKPOINTS → native + stand-down (once).
 *   - Test 9 (soft-deny): armed + dirty → deny; a one-shot GATE-AIRBAG override token allows.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  matchDestructive,
  takeSnapshot,
  checkAirbag,
  nativeCheckpointProbe,
  listSnapshots,
  snapshotListSchemaOk,
} from '../lib/airbag.mjs'
import { AIRBAG_UNTRACKED_MAX_FILES } from '../lib/constants.mjs'

/** A DI git runner spy: records every {args, opts}; answers by argv[0..] prefix. */
function mkRunner(responses: Record<string, any> = {}) {
  const calls: Array<{ args: string[]; opts: any }> = []
  const run = (args: string[], opts: any = {}) => {
    calls.push({ args, opts })
    const key = args.join(' ')
    for (const [k, v] of Object.entries(responses)) {
      if (key.startsWith(k)) return typeof v === 'function' ? v(args, opts) : v
    }
    return '' // default: empty stdout (clean tree, no sha)
  }
  return { run, calls }
}

describe('matchDestructive', () => {
  it('Test 1: classifies each destructive class + variants; safe commands → null', () => {
    expect(matchDestructive('git reset --hard HEAD~1')).toEqual({ cmdClass: 'reset-hard' })
    expect(matchDestructive('git reset --soft HEAD~1')).toBeNull()
    expect(matchDestructive('git reset HEAD~1')).toBeNull()

    expect(matchDestructive('git clean -fd')).toEqual({ cmdClass: 'clean', ignoredInBlast: false })
    expect(matchDestructive('git clean -ffd')).toEqual({ cmdClass: 'clean', ignoredInBlast: false })
    expect(matchDestructive('git clean -fdx')).toEqual({ cmdClass: 'clean', ignoredInBlast: true })

    expect(matchDestructive('git checkout -- src/x.ts')).toEqual({ cmdClass: 'checkout-paths' })
    expect(matchDestructive('git checkout main')).toBeNull()

    expect(matchDestructive('git restore src/x.ts')).toEqual({ cmdClass: 'restore' })
    expect(matchDestructive('git restore --staged src/x.ts')).toBeNull()
    expect(matchDestructive('git restore --staged --worktree src/x.ts')).toEqual({ cmdClass: 'restore' })

    expect(matchDestructive('git push --force')).toEqual({ cmdClass: 'force-push' })
    expect(matchDestructive('git push -f origin main')).toEqual({ cmdClass: 'force-push' })
    expect(matchDestructive('git push --force-with-lease')).toEqual({ cmdClass: 'force-push' })
    expect(matchDestructive('git push')).toBeNull()
    expect(matchDestructive('git push origin main')).toBeNull()

    expect(matchDestructive('git branch -D feature/x')).toEqual({ cmdClass: 'branch-delete', branchName: 'feature/x' })

    expect(matchDestructive('git rebase main')).toEqual({ cmdClass: 'rebase' })
    expect(matchDestructive('git rebase --continue')).toBeNull()
    expect(matchDestructive('git rebase --abort')).toBeNull()
    expect(matchDestructive('git rebase --skip')).toBeNull()

    // safe: non-destructive git + non-git destruction (the security guard's surface)
    expect(matchDestructive('git status')).toBeNull()
    expect(matchDestructive('git add file.ts')).toBeNull()
    expect(matchDestructive('pnpm sma build-index')).toBeNull()
    expect(matchDestructive('rm -rf foo')).toBeNull()
    expect(matchDestructive('')).toBeNull()
  })
})

describe('takeSnapshot', () => {
  it('Test 2: clean tree → pins exactly <id>/head HEAD; fixed argv arrays; no stash', () => {
    const { run, calls } = mkRunner({ 'status --porcelain': '' })
    const r = takeSnapshot({ cmdClass: 'reset-hard', meta: {} }, { runGit: run, now: () => 1751000000000 })

    expect(r.ok).toBe(true)
    expect(r.dirty).toBe(false)
    expect(r.untrackedCount).toBe(0)
    expect(r.cmdClass).toBe('reset-hard')
    expect(typeof r.elapsedMs).toBe('number')

    const updateRefs = calls.filter((c) => c.args[0] === 'update-ref')
    expect(updateRefs).toHaveLength(1)
    expect(updateRefs[0].args[1]).toMatch(/^refs\/sma\/airbag\/.*\/head$/)
    expect(updateRefs[0].args[2]).toBe('HEAD')
    // no stash-create on a clean tree
    expect(calls.some((c) => c.args[0] === 'stash')).toBe(false)
    // EVERY runner call is a fixed argv ARRAY (never a shell string)
    for (const c of calls) expect(Array.isArray(c.args)).toBe(true)
  })

  it('Test 3: dirty + untracked → stash pinned; ONE batched hash-object; mktree index names', () => {
    const responses = {
      'status --porcelain': ' M tracked.ts\n?? a.txt\n?? b.txt\n',
      'stash create': 'deadbeef\n',
      'hash-object': 'aaa111\nbbb222\n',
      mktree: 'tree999\n',
    }
    const { run, calls } = mkRunner(responses)
    const r = takeSnapshot({ cmdClass: 'checkout-paths', meta: {} }, { runGit: run, statSize: () => 10 })

    expect(r.ok).toBe(true)
    expect(r.dirty).toBe(true)
    expect(r.untrackedCount).toBe(2)

    const stashRef = calls.find((c) => c.args[0] === 'update-ref' && c.args[1].endsWith('/stash'))
    expect(stashRef?.args[2]).toBe('deadbeef')

    const ho = calls.filter((c) => c.args[0] === 'hash-object')
    expect(ho).toHaveLength(1) // ONE batched call
    expect(ho[0].args).toContain('--stdin-paths')
    expect(ho[0].opts.input).toBe('a.txt\nb.txt\n')

    const mk = calls.find((c) => c.args[0] === 'mktree')
    expect(mk?.opts.input).toContain('\t0')
    expect(mk?.opts.input).toContain('\t1')

    const utRef = calls.find((c) => c.args[0] === 'update-ref' && c.args[1].endsWith('/untracked'))
    expect(utRef?.args[2]).toBe('tree999')
    expect(r.indexPathMap).toEqual({ 0: 'a.txt', 1: 'b.txt' })
  })

  it('Test 4: caps — >MAX files and >MAX bytes truncate; clean -x sets ignoredNotCaptured', () => {
    // file-count cap: MAX+1 untracked entries
    const many = Array.from({ length: AIRBAG_UNTRACKED_MAX_FILES + 1 }, (_, i) => `?? f${i}.txt`).join('\n') + '\n'
    const r1 = takeSnapshot(
      { cmdClass: 'clean', meta: {} },
      {
        runGit: mkRunner({ 'status --porcelain': many, 'hash-object': 'x\n', mktree: 't\n' }).run,
        statSize: () => 1,
      },
    )
    expect(r1.untrackedTruncated).toBe(true)
    expect(r1.untrackedCount).toBe(AIRBAG_UNTRACKED_MAX_FILES)
    expect(r1.untrackedRemaining.length).toBe(1)

    // byte cap: 6 MB each, 10 MB cap → only the first captured, then truncate
    const r2 = takeSnapshot(
      { cmdClass: 'clean', meta: {} },
      {
        runGit: mkRunner({ 'status --porcelain': '?? big1\n?? big2\n', 'hash-object': 's1\n', mktree: 't\n' }).run,
        statSize: () => 6 * 1024 * 1024,
      },
    )
    expect(r2.untrackedTruncated).toBe(true)
    expect(r2.untrackedCount).toBe(1)

    // clean -x: ignored files are never enumerated
    const r3 = takeSnapshot(
      { cmdClass: 'clean', meta: { ignoredInBlast: true } },
      { runGit: mkRunner({ 'status --porcelain': '' }).run },
    )
    expect(r3.ignoredNotCaptured).toBe(true)
  })

  it('Test 5: per-class extra pins — branch-delete / force-push / rebase', () => {
    // branch-delete pins the doomed tip
    const bd = mkRunner({ 'status --porcelain': '' })
    takeSnapshot({ cmdClass: 'branch-delete', meta: { branchName: 'feature/x' } }, { runGit: bd.run })
    const bref = bd.calls.find((c) => c.args[0] === 'update-ref' && c.args[1].endsWith('/branch-feature-x'))
    expect(bref?.args[2]).toBe('refs/heads/feature/x')

    // force-push pins the remote-tracking ref of the current branch
    const fp = mkRunner({ 'status --porcelain': '', 'symbolic-ref --short HEAD': 'main\n' })
    takeSnapshot({ cmdClass: 'force-push', meta: {} }, { runGit: fp.run })
    const rref = fp.calls.find((c) => c.args[0] === 'update-ref' && c.args[1].endsWith('/remote'))
    expect(rref?.args[2]).toBe('refs/remotes/origin/main')

    // rebase pins head + current branch ref
    const rb = mkRunner({ 'status --porcelain': '', 'symbolic-ref --short HEAD': 'main\n' })
    takeSnapshot({ cmdClass: 'rebase', meta: {} }, { runGit: rb.run })
    expect(rb.calls.some((c) => c.args[0] === 'update-ref' && c.args[1].endsWith('/head'))).toBe(true)
    expect(rb.calls.some((c) => c.args[0] === 'update-ref' && c.args[1].endsWith('/branch-main'))).toBe(true)
  })

  it('Test 6: fail-open — a throwing runner → {ok:false} and NEVER throws', () => {
    const run = () => {
      throw new Error('boom')
    }
    let r: any
    expect(() => {
      r = takeSnapshot({ cmdClass: 'reset-hard', meta: {} }, { runGit: run })
    }).not.toThrow()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom')
  })
})

describe('checkAirbag', () => {
  it('Test 6b: a snapshot failure degrades to WARN + ok:false receipt, never a deny', () => {
    const append = vi.fn()
    const res = checkAirbag(
      { tool_name: 'Bash', tool_input: { command: 'git reset --hard' } },
      {
        runGit: () => {
          throw new Error('x')
        },
        env: {},
        dirs: { journalDir: '/j' },
        terminalId: 't',
        journalAppend: append,
      },
    )
    expect(res.receipt.ok).toBe(false)
    expect(res.warns.length).toBeGreaterThan(0)
    expect(res.deny).toBeUndefined()
    // the ok:false receipt IS journaled (honest denominator)
    expect(append).toHaveBeenCalled()
    expect(append.mock.calls[0][0].detail.ok).toBe(false)
  })

  it('Test 7: the design-trap spy — the archive verb is NEVER passed on ANY path', () => {
    const allCalls: string[][] = []
    const record = (responses: Record<string, any>) => {
      const { run, calls } = mkRunner(responses)
      const wrapped = (args: string[], opts: any) => {
        allCalls.push(args)
        return run(args, opts)
      }
      return wrapped
    }
    for (const cls of ['reset-hard', 'clean', 'checkout-paths', 'restore', 'force-push', 'branch-delete', 'rebase']) {
      takeSnapshot(
        { cmdClass: cls, meta: { branchName: 'x' } },
        {
          runGit: record({
            'status --porcelain': ' M t.ts\n?? u.txt\n',
            'stash create': 'sha\n',
            'hash-object': 'b\n',
            mktree: 'tr\n',
            'symbolic-ref --short HEAD': 'main\n',
          }),
          statSize: () => 1,
        },
      )
    }
    // by DESIGN the assertion is on the spy: no argv fragment is ever the archive verb
    for (const args of allCalls) expect(args).not.toContain('bundle')
    expect(allCalls.length).toBeGreaterThan(0)
  })

  it('Test 8: probe — native false today; SMA_NATIVE_CHECKPOINTS → native + stand-down once', () => {
    expect(nativeCheckpointProbe({ env: {} })).toEqual({ native: false, probeVersion: 1 })
    expect(nativeCheckpointProbe({ env: { SMA_NATIVE_CHECKPOINTS: '1' } }).native).toBe(true)

    const run = vi.fn()
    const append = vi.fn()
    const seen = { keys: {} }
    const evt = { tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }
    const opts = { runGit: run, env: { SMA_NATIVE_CHECKPOINTS: '1' }, dirs: { journalDir: '/j' }, terminalId: 't', journalAppend: append, seen }

    const res = checkAirbag(evt, opts)
    expect(run).not.toHaveBeenCalled() // stand-down: NO snapshot
    expect(res.warns).toEqual([])
    expect(append).toHaveBeenCalledTimes(1)
    expect(append.mock.calls[0][0].detail.standDown).toBe(true)
    // a second event in the same session emits NO new note
    checkAirbag(evt, opts)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('Test 9: soft-deny — armed + dirty → deny; a one-shot GATE-AIRBAG override token allows', () => {
    const gatesDir = mkdtempSync(join(tmpdir(), 'airbag-gates-'))
    const journalDir = mkdtempSync(join(tmpdir(), 'airbag-journal-'))
    const dirtyRunner = () => ' M tracked.ts\n' // status --porcelain → dirty tracked
    const runGit = (args: string[]) => (args.join(' ').startsWith('status') ? dirtyRunner() : '')
    const evt = { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~1' } }
    const base = { runGit, env: { SMA_AIRBAG_DENY: '1' }, dirs: { journalDir, gatesDir }, terminalId: 't', seen: { keys: {} } }

    // armed + dirty, no evidence → deny
    const denied = checkAirbag(evt, { ...base, seen: { keys: {} } })
    expect(denied.deny).toBeTruthy()
    expect(denied.deny.text).toContain('GATE-AIRBAG')

    // drop a one-shot override token → allowed (token consumed)
    const tokenPath = join(gatesDir, 'override-GATE-AIRBAG.json')
    writeFileSync(tokenPath, JSON.stringify({ reason: 'planned force reset', terminal: 't' }), 'utf8')
    const allowed = checkAirbag(evt, { ...base, seen: { keys: {} } })
    expect(allowed.deny).toBeUndefined()
    expect(existsSync(tokenPath)).toBe(false) // consumed
  })
})

// ── BL-172 (2026-07-10): the --schema-check contract — receipts pin STRUCTURE, never accruing refs ──

describe('snapshotListSchemaOk — deterministic airbag-list shape check (Test 10, BL-172)', () => {
  it('accepts the honest-empty list AND a real listSnapshots result — ref accrual never changes the verdict', () => {
    expect(snapshotListSchemaOk([])).toBe(true)
    const { run } = mkRunner({
      'for-each-ref':
        'sha1\trefs/sma/airbag/20260710-120000-1/head\nsha2\trefs/sma/airbag/20260710-120000-1/stash\nsha3\trefs/sma/airbag/20260709-090000-7/head\n',
    })
    const groups = listSnapshots({ runGit: run })
    expect(groups.length).toBe(2)
    expect(snapshotListSchemaOk(groups)).toBe(true)
  })

  it('rejects a group without an id, non-array refnames, non-object refs, and a non-array input', () => {
    expect(snapshotListSchemaOk([{ refs: {}, refnames: [] }])).toBe(false)
    expect(snapshotListSchemaOk([{ id: 'x', refs: {}, refnames: 'r' }])).toBe(false)
    expect(snapshotListSchemaOk([{ id: 'x', refs: null, refnames: [] }])).toBe(false)
    expect(snapshotListSchemaOk('nope')).toBe(false)
  })
})
