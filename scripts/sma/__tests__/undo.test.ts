/**
 * Tests for `sma undo` — restoreSnapshot / listSnapshots / pruneSnapshots
 * (Phase 9.2 Plan 05, Task 2). These run against REAL git in mkdtemp repos —
 * the drill is only honest against real git (no mocked runner in this file).
 *
 *   - Test 1: the BYTE-FOR-BYTE drill — snapshot → catastrophe (reset --hard + clean
 *     -fd) → restore → every worktree file byte-identical (tracked mod AND untracked).
 *     This IS the S2 quarterly-drill in CI form.
 *   - Test 2: undo protects itself — restore takes a fresh airbag snapshot FIRST
 *     (the ref-group count grows by one).
 *   - Test 3: targeting + dry-run — --to <id> restores an older snapshot; --dry-run
 *     performs ZERO writes.
 *   - Test 4: branch-delete recovery — the pinned tip resurrects the branch after -D.
 *   - Test 5: prune keeps the newest KEEP groups and unpins the rest.
 *   - Test 6: latency tripwire — a snapshot stays within a multiple of the host's
 *     OWN measured git-spawn cost (a fixed wall-clock bound measured the host,
 *     not the code, and went flaky on a shared Windows box).
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { takeSnapshot, checkAirbag, restoreSnapshot, listSnapshots, pruneSnapshots } from '../lib/airbag.mjs'

/** A REAL execFileSync-backed git runner over `cwd`; buffer mode for blob bytes. */
function realRunner(cwd: string) {
  return (args: string[], opts: any = {}) =>
    execFileSync('git', args, { cwd, input: opts.input, encoding: opts.buffer ? 'buffer' : 'utf8' }) as any
}

/**
 * Assert an airbag receipt / restore result is ok, WITH the reason when it is not.
 *
 * takeSnapshot and restoreSnapshot are fail-soft by design (a snapshot failure is
 * a WARN and an `ok:false` receipt, never an exception — that law is why the gate
 * can never block a user). The cost lands here: `expect(receipt.ok).toBe(true)`
 * turns a named git failure into "expected false to be true", which is exactly the
 * unreadable red this file produced under full-suite load. `error` and `warns` are
 * on the object already; this puts them in the report.
 */
function expectAirbagOk(r: any) {
  expect({ ok: r.ok, error: r.error, warns: r.warns }).toMatchObject({ ok: true })
}

/** A fresh temp repo with one base commit (tracked.ts = "v1"). */
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'airbag-repo-'))
  const g = realRunner(dir)
  g(['init', '-q'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  g(['config', 'commit.gpgsign', 'false'])
  g(['config', 'core.autocrlf', 'false']) // deterministic bytes (no EOL conversion)
  writeFileSync(join(dir, 'tracked.ts'), 'v1\n')
  g(['add', 'tracked.ts'])
  g(['commit', '-q', '-m', 'base'])
  // the journal lives OUTSIDE the repo so `git clean -fd` cannot nuke it mid-drill
  const journalDir = mkdtempSync(join(tmpdir(), 'airbag-j-'))
  return { dir, g, journalDir }
}

describe('sma undo (real git)', () => {
  it('Test 1: the byte-for-byte drill restores tracked mod AND untracked content', () => {
    const { dir, g, journalDir } = newRepo()

    // dirty tracked + an untracked file
    writeFileSync(join(dir, 'tracked.ts'), 'v2-modified\n')
    writeFileSync(join(dir, 'untracked.txt'), 'untracked-content\n')
    const trackedBefore = readFileSync(join(dir, 'tracked.ts'))
    const untrackedBefore = readFileSync(join(dir, 'untracked.txt'))

    // snapshot via checkAirbag (snapshots + journals the receipt with indexPathMap)
    const evt = { tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }
    const res = checkAirbag(evt, { runGit: g, dirs: { journalDir }, terminalId: 't', repoRoot: dir })
    expectAirbagOk(res.receipt)

    // catastrophe
    g(['reset', '--hard'])
    g(['clean', '-fd'])
    expect(readFileSync(join(dir, 'tracked.ts'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(dir, 'untracked.txt'))).toBe(false)

    // ONE action back
    const r = restoreSnapshot({}, { runGit: g, dirs: { journalDir }, repoRoot: dir, terminalId: 't' })
    expectAirbagOk(r)
    expect(r.untrackedRestored).toBe(1)

    // byte-for-byte
    expect(readFileSync(join(dir, 'tracked.ts'))).toEqual(trackedBefore)
    expect(readFileSync(join(dir, 'untracked.txt'))).toEqual(untrackedBefore)
  })

  it('Test 2: undo protects itself — the ref-group count grows by one', () => {
    const { dir, g, journalDir } = newRepo()
    writeFileSync(join(dir, 'tracked.ts'), 'v2\n')
    checkAirbag(
      { tool_name: 'Bash', tool_input: { command: 'git reset --hard' } },
      { runGit: g, dirs: { journalDir }, terminalId: 't', repoRoot: dir },
    )

    const before = listSnapshots({ runGit: g }).length
    restoreSnapshot({}, { runGit: g, dirs: { journalDir }, repoRoot: dir, terminalId: 't' })
    const after = listSnapshots({ runGit: g }).length
    expect(after).toBe(before + 1) // the fresh pre-undo self-snapshot
  })

  it('Test 3: targeting + dry-run — --to restores a specific snapshot; --dry-run writes nothing', () => {
    const { dir, g, journalDir } = newRepo()
    const opts = { runGit: g, dirs: { journalDir }, terminalId: 't', repoRoot: dir }

    // two snapshots at distinct (injected) timestamps
    writeFileSync(join(dir, 'tracked.ts'), 'older\n')
    checkAirbag({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }, { ...opts, now: () => 1751000000000 })
    writeFileSync(join(dir, 'tracked.ts'), 'newer\n')
    checkAirbag({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }, { ...opts, now: () => 1751000600000 })

    const groups = listSnapshots({ runGit: g })
    expect(groups.length).toBe(2)

    // --dry-run: ZERO writes (no new snapshot ref group)
    const dry = restoreSnapshot({ dryRun: true }, opts)
    expect(dry.dryRun).toBe(true)
    expect(dry.plan.snapshotId).toBe(groups[0].id) // newest by default
    expect(listSnapshots({ runGit: g }).length).toBe(2) // unchanged — no self-snapshot

    // --to <olderId> targets the specific older snapshot
    const olderId = groups[groups.length - 1].id
    const r = restoreSnapshot({ snapshotId: olderId }, opts)
    expectAirbagOk(r)
    expect(r.snapshotId).toBe(olderId)
  })

  it('Test 4: branch-delete recovery — the pinned tip resurrects the branch after -D', () => {
    const { dir, g } = newRepo()
    g(['branch', 'feature/x'])
    const tip = String(g(['rev-parse', 'refs/heads/feature/x'])).trim()

    const receipt = takeSnapshot({ cmdClass: 'branch-delete', meta: { branchName: 'feature/x' } }, { runGit: g, repoRoot: dir })
    expectAirbagOk(receipt)
    expect(receipt.refs.branch).toBeTruthy()

    g(['branch', '-D', 'feature/x'])
    // the doomed sha is still reachable via the airbag ref
    expect(String(g(['rev-parse', receipt.refs.branch])).trim()).toBe(tip)
    // the documented one-liner resurrects it
    g(['branch', 'feature/x', receipt.refs.branch])
    expect(String(g(['rev-parse', 'refs/heads/feature/x'])).trim()).toBe(tip)
  })

  it('Test 5: prune keeps the newest KEEP groups and unpins the rest', () => {
    const { dir, g } = newRepo()
    for (let i = 0; i < 4; i++) {
      takeSnapshot({ cmdClass: 'reset-hard', meta: {} }, { runGit: g, now: () => 1751000000000 + i * 60000, repoRoot: dir })
    }
    expect(listSnapshots({ runGit: g }).length).toBe(4)

    // now in the snapshot era so the age-cap does not mark the fixed timestamps expired
    const res = pruneSnapshots({ keep: 2 }, { runGit: g, dirs: { journalDir: join(dir, '.j') }, terminalId: 't', now: () => 1751000300000 })
    expect(res.removed.length).toBe(2)
    expect(listSnapshots({ runGit: g }).length).toBe(2)
  })

  it('Test 6: latency tripwire — a snapshot stays within a multiple of this host\'s own git cost', () => {
    const { dir, g } = newRepo()
    writeFileSync(join(dir, 'tracked.ts'), 'dirty\n')
    writeFileSync(join(dir, 'u.txt'), 'x\n')

    // WHY A DERIVED BOUND: takeSnapshot spawns ~12 git processes. A fixed
    // wall-clock bound therefore measures PROCESS SPAWN COST — i.e. the host —
    // not this code. On a shared Windows box (contention + AV scanning the temp
    // tree) a spawn costs many times what CI sees, and the tripwire fires on a
    // machine that is merely busy. So we first measure what ONE git round-trip
    // costs on THIS host, right now, in THIS temp repo, and scale the budget by
    // it. A real regression (an added scan, a network call, an accidental O(n))
    // still trips the wire; a loaded host no longer does.
    const warm: number[] = []
    for (let i = 0; i < 5; i++) {
      const w0 = Date.now()
      g(['rev-parse', 'HEAD'])
      warm.push(Date.now() - w0)
    }
    const perGit = Math.max(1, Math.min(...warm)) // cheapest observed spawn = the host's floor
    const SPAWNS = 12 // git invocations inside takeSnapshot
    const SAFETY = 4 // headroom for the non-git work + scheduling jitter
    const budget = Math.max(2000, perGit * SPAWNS * SAFETY)

    const t0 = Date.now()
    const r = takeSnapshot({ cmdClass: 'reset-hard', meta: {} }, { runGit: g, repoRoot: dir })
    const elapsed = Date.now() - t0
    expectAirbagOk(r)
    // regression tripwire only; the SLO is bench over live receipts
    expect({ elapsed, budget, perGit, within: elapsed < budget }).toMatchObject({ within: true })
  })
})
