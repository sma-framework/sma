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
 *   - Test 6: latency tripwire — a snapshot completes under a generous CI bound.
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
    expect(res.receipt.ok).toBe(true)

    // catastrophe
    g(['reset', '--hard'])
    g(['clean', '-fd'])
    expect(readFileSync(join(dir, 'tracked.ts'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(dir, 'untracked.txt'))).toBe(false)

    // ONE action back
    const r = restoreSnapshot({}, { runGit: g, dirs: { journalDir }, repoRoot: dir, terminalId: 't' })
    expect(r.ok).toBe(true)
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
    expect(r.ok).toBe(true)
    expect(r.snapshotId).toBe(olderId)
  })

  it('Test 4: branch-delete recovery — the pinned tip resurrects the branch after -D', () => {
    const { dir, g } = newRepo()
    g(['branch', 'feature/x'])
    const tip = String(g(['rev-parse', 'refs/heads/feature/x'])).trim()

    const receipt = takeSnapshot({ cmdClass: 'branch-delete', meta: { branchName: 'feature/x' } }, { runGit: g, repoRoot: dir })
    expect(receipt.ok).toBe(true)
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

  it('Test 6: latency tripwire — a snapshot completes under a generous CI bound', () => {
    const { dir, g } = newRepo()
    writeFileSync(join(dir, 'tracked.ts'), 'dirty\n')
    writeFileSync(join(dir, 'u.txt'), 'x\n')
    const t0 = Date.now()
    const r = takeSnapshot({ cmdClass: 'reset-hard', meta: {} }, { runGit: g, repoRoot: dir })
    expect(r.ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2000) // regression tripwire only; SLO is bench over live receipts
  })
})
