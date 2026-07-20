/**
 * Tests for scripts/sma/lib/worktree.mjs (Phase 9.3 Plan 14).
 *
 * Per-terminal worktree isolation (D-9.3-24a/b): `sma worktree` provisions or
 * reuses a per-session worktree DIRECTORY so parallel human Claude Code sessions
 * physically cannot overwrite each other on this shared, auto-deploy checkout.
 *
 * The two Windows hazards the guards exist for (the reason these tests are the
 * load-bearing safety proofs):
 *   - feedback_worktree_base_windows_bug: a Windows worktree can branch from a
 *     commit OLDER than HEAD → capture EXPECTED_BASE + verify + hard-reset.
 *   - feedback_worktree_shell_teleport: a teleported shell CWD runs git on the
 *     wrong branch → every git call passes an EXPLICIT cwd (no bare `cd &&`).
 *
 * A DI git runner (makeMockGit) records every {args, cwd} it receives so the
 * tests never spawn a real `git worktree`, never touch the network, and can
 * assert the explicit-cwd invariant mechanically. `.sma/` coordination
 * resolution (registry.smaRoot) is ALREADY worktree-transparent and is NOT
 * exercised here — plan 14 provisions working-tree directories only.
 */

import { describe, it, expect } from 'vitest'
import { resolve as resolvePath } from 'node:path'

import {
  provisionWorktree,
  reuseOrProvision,
  listWorktrees,
  removeWorktree,
  resolveSiblingRepo,
  captureExpectedBase,
  verifyWorktreeBase,
  WORKTREE_BRANCH_PREFIX,
} from '../lib/worktree.mjs'

/**
 * makeMockGit — a recording DI runner. `baseByCwd` maps a cwd -> the sha its
 * `rev-parse HEAD` returns (so a worktree cwd can report a DIFFERENT base than
 * the main checkout — the Windows base bug). `worktrees` is the porcelain text
 * `worktree list --porcelain` returns. `fail:true` makes every call throw (the
 * fail-open probe). Records EVERY {args, cwd} pair.
 */
function makeMockGit(
  opts: { baseByCwd?: Record<string, string>; worktrees?: string; fail?: boolean } = {},
) {
  const calls: { args: string[]; cwd?: string }[] = []
  const run = (args: string[], o: { cwd?: string } = {}) => {
    calls.push({ args, cwd: o.cwd })
    if (opts.fail) throw new Error('git failed (mock)')
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      const map = opts.baseByCwd ?? {}
      return `${map[o.cwd ?? ''] ?? 'DEFAULT_SHA'}\n`
    }
    if (args[0] === 'worktree' && args[1] === 'list') return opts.worktrees ?? ''
    return ''
  }
  return { run, calls }
}

describe('worktree.mjs — per-terminal provisioning + Windows guards', () => {
  it('Test 1 — provision captures EXPECTED_BASE before add, then verifies the base after add', () => {
    const g = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'BASE' } })
    const res = provisionWorktree({ branch: 'sma-wt/a', path: '/wt', execGit: g.run, cwd: '/main' })

    const idxRev = g.calls.findIndex((c) => c.args[0] === 'rev-parse' && c.args[1] === 'HEAD')
    const idxAdd = g.calls.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'add')
    // rev-parse HEAD (capture) precedes worktree add
    expect(idxRev).toBeGreaterThanOrEqual(0)
    expect(idxAdd).toBeGreaterThan(idxRev)
    // base verified AFTER add: a rev-parse HEAD in the new worktree's cwd
    const idxVerify = g.calls.findIndex(
      (c, i) => i > idxAdd && c.args[0] === 'rev-parse' && c.args[1] === 'HEAD' && c.cwd === '/wt',
    )
    expect(idxVerify).toBeGreaterThan(idxAdd)
    expect(res.ok).toBe(true)
    expect(res.expectedBase).toBe('BASE')
  })

  it('Test 2 — base mismatch → hard-reset in the worktree cwd; a matching base does NOT reset', () => {
    // mismatch: the worktree reports an OLDER base than main (the Windows bug)
    const g = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'OLD' } })
    const res = provisionWorktree({ branch: 'sma-wt/b', path: '/wt', execGit: g.run, cwd: '/main' })
    expect(res.baseFixed).toBe(true)
    const reset = g.calls.find((c) => c.args[0] === 'reset' && c.args[1] === '--hard')
    expect(reset?.args[2]).toBe('BASE') // reset --hard <EXPECTED_BASE>, never --soft
    expect(reset?.cwd).toBe('/wt') // in the worktree, not main

    // match: no reset issued at all
    const g2 = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'BASE' } })
    const res2 = provisionWorktree({ branch: 'sma-wt/c', path: '/wt', execGit: g2.run, cwd: '/main' })
    expect(res2.baseFixed).toBe(false)
    expect(g2.calls.some((c) => c.args[0] === 'reset')).toBe(false)
  })

  it('Test 3 — every git call carries an explicit cwd and is an args array (no bare `cd &&`)', () => {
    const g = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'OLD' } })
    provisionWorktree({ branch: 'sma-wt/d', path: '/wt', execGit: g.run, cwd: '/main' })
    expect(g.calls.length).toBeGreaterThan(0)
    for (const c of g.calls) {
      expect(Array.isArray(c.args)).toBe(true) // args array, never a shell string
      expect(typeof c.cwd).toBe('string') // explicit cwd on every call (teleport guard)
      expect(c.cwd).toBeTruthy()
      expect(c.args.join(' ')).not.toMatch(/(^|\s)cd\s/) // no bare cd anywhere
    }
  })

  it('Test 4 — reuse over re-provision; porcelain list parse; remove uses explicit cwd + no --force by default', () => {
    const porcelain =
      'worktree /main\nHEAD abcabc\nbranch refs/heads/main\n\n' +
      'worktree /wt-a\nHEAD defdef\nbranch refs/heads/sma-wt/a\n'
    const g = makeMockGit({ worktrees: porcelain })
    const list = listWorktrees({ execGit: g.run, cwd: '/main' })
    expect(list).toHaveLength(2)
    expect(list[1].path).toBe('/wt-a')
    expect(list[1].branch).toBe('refs/heads/sma-wt/a')

    // reuse returns the existing worktree — no duplicate `worktree add`
    const r = reuseOrProvision({ branch: 'refs/heads/sma-wt/a', path: '/wt-a', execGit: g.run, cwd: '/main' })
    expect(r.reused).toBe(true)
    expect(g.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add')).toBe(false)

    // remove: explicit cwd, no --force unless asked
    const g2 = makeMockGit()
    removeWorktree({ path: '/wt-a', execGit: g2.run, cwd: '/main' })
    const rm = g2.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')
    expect(rm?.cwd).toBe('/main')
    expect(rm?.args).not.toContain('--force')

    const g3 = makeMockGit()
    removeWorktree({ path: '/wt-a', execGit: g3.run, cwd: '/main', force: true })
    const rm3 = g3.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')
    expect(rm3?.args).toContain('--force')
  })

  it('Test 5 — sibling-repo resolution order: env → config → profile → relative ../sma fallback (tolerant)', () => {
    // env wins over everything
    expect(
      resolveSiblingRepo({
        env: { SMA_PRODUCT_REPO: '/abs/env' },
        readConfig: () => ({ productRepo: '/abs/cfg' }),
        readProfile: () => ({ profile: { productRepo: '/abs/prof' } }),
        cwd: '/main',
      }),
    ).toMatchObject({ path: '/abs/env', source: 'env' })

    // config wins when no env
    expect(
      resolveSiblingRepo({
        env: {},
        readConfig: () => ({ productRepo: '/abs/cfg' }),
        readProfile: () => ({ profile: { productRepo: '/abs/prof' } }),
        cwd: '/main',
      }),
    ).toMatchObject({ path: '/abs/cfg', source: 'config' })

    // profile wins when no env/config
    expect(
      resolveSiblingRepo({
        env: {},
        readConfig: () => ({}),
        readProfile: () => ({ profile: { productRepo: '/abs/prof' } }),
        cwd: '/main',
      }),
    ).toMatchObject({ path: '/abs/prof', source: 'profile' })

    // relative fallback when nothing is recorded
    const fb = resolveSiblingRepo({ env: {}, readConfig: () => ({}), readProfile: () => ({ profile: {} }), cwd: '/main' })
    expect(fb.source).toBe('relative')
    expect(fb.path).toBe(resolvePath('/main', '../sma'))

    // corrupt config/profile (readers throw) still falls through to relative — never throws
    const fb2 = resolveSiblingRepo({
      env: {},
      readConfig: () => {
        throw new Error('corrupt config')
      },
      readProfile: () => {
        throw new Error('corrupt profile')
      },
      cwd: '/main',
    })
    expect(fb2.source).toBe('relative')
  })

  it('Test 6 — fail-open: a git error returns {ok:false, fellBackToPrimary:true} and never throws', () => {
    const g = makeMockGit({ fail: true })
    const res = provisionWorktree({ branch: 'sma-wt/z', path: '/wt', execGit: g.run, cwd: '/main' })
    expect(res.ok).toBe(false)
    expect(res.fellBackToPrimary).toBe(true)
    expect(typeof res.message).toBe('string')
    // listWorktrees is fail-open too — a throwing git yields an empty list, never a throw
    expect(listWorktrees({ execGit: g.run, cwd: '/main' })).toEqual([])
  })

  it('captureExpectedBase + verifyWorktreeBase are the injectable base primitives', () => {
    const g = makeMockGit({ baseByCwd: { '/main': 'BASE', '/wt': 'OLD' } })
    expect(captureExpectedBase({ execGit: g.run, cwd: '/main' })).toBe('BASE')
    const v = verifyWorktreeBase({ execGit: g.run, cwd: '/wt', expectedBase: 'BASE' })
    expect(v.matches).toBe(false)
    expect(v.actual).toBe('OLD')
  })

  it('WORKTREE_BRANCH_PREFIX is a stable non-empty per-terminal branch stem', () => {
    expect(typeof WORKTREE_BRANCH_PREFIX).toBe('string')
    expect(WORKTREE_BRANCH_PREFIX.length).toBeGreaterThan(0)
  })
})
