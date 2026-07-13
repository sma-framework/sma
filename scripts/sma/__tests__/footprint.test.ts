/**
 * Tests for scripts/sma/lib/footprint.mjs + grill.standingFootprint (49.4-07 — the
 * economy ladder as a claim + a deterministic receipt). The five load-bearing behaviors:
 *   Test 1 — claim parse: parseFootprintClaim coerces the frontmatter dash-entry;
 *            absent block -> null; missing new_deps -> 0
 *   Test 2 — claim lint: lintFootprintClaim flags negative/non-numeric fields +
 *            tolerance_pct outside 0..200 with the {rule,field,message} shape
 *   Test 3 — actuals: footprintActuals folds a FAKE execGit's log+numstat into
 *            {files, loc, new_deps, commits}; binary '-' skipped; zero commits -> empty
 *   Test 4 — receipt verdict: within-tolerance -> verified (no calls); beyond tolerance
 *            on any axis -> overrun + appendVerdict once + draftLesson once; new_deps
 *            tolerance is 0
 *   Test 5 — standing toggle: no-claim registers ONE challenge (idempotent) + gate blocks;
 *            a claim resolves it (gate allows); an untouched plan stays {grilled:false}
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'

import { parseFootprintClaim, lintFootprintClaim, footprintActuals, footprintReceipt } from '../lib/footprint.mjs'
import { standingFootprint, grillGate, readChallenges } from '../lib/grill.mjs'

// ── Test 1 — claim parse ─────────────────────────────────────────────────────
describe('footprint — parseFootprintClaim (Test 1)', () => {
  const withClaim =
    '---\nphase: 49.4\nplan: 07\nfootprint:\n  - files: 9\n    new_files: 2\n    loc: 750\n    new_deps: 0\n    tolerance_pct: 50\nautonomous: true\n---\n\nbody\n'
  const noBlock = '---\nphase: 49.4\nplan: 07\nautonomous: true\n---\n\nbody\n'
  const noDeps =
    '---\nphase: 49.4\nplan: 08\nfootprint:\n  - files: 3\n    new_files: 0\n    loc: 120\n    tolerance_pct: 25\n---\n\nbody\n'

  it('coerces the dash-entry to numeric fields', () => {
    const claim = parseFootprintClaim('x-PLAN.md', { readFn: () => withClaim })
    expect(claim).toEqual({ files: 9, new_files: 2, loc: 750, new_deps: 0, tolerance_pct: 50 })
  })

  it('returns null when there is no footprint block (honest absent)', () => {
    expect(parseFootprintClaim('x-PLAN.md', { readFn: () => noBlock })).toBeNull()
  })

  it('defaults a missing new_deps to 0', () => {
    const claim = parseFootprintClaim('x-PLAN.md', { readFn: () => noDeps })
    expect(claim?.new_deps).toBe(0)
    expect(claim?.loc).toBe(120)
  })
})

// ── Test 2 — claim lint ──────────────────────────────────────────────────────
describe('footprint — lintFootprintClaim (Test 2)', () => {
  it('passes a well-formed claim', () => {
    expect(lintFootprintClaim({ files: 9, new_files: 2, loc: 750, new_deps: 0, tolerance_pct: 50 })).toEqual([])
  })

  it('flags a negative field with the {rule,field,message} shape', () => {
    const v = lintFootprintClaim({ files: -1, new_files: 2, loc: 750, new_deps: 0, tolerance_pct: 50 })
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ rule: 'FOOT-SCHEMA', field: 'files' })
    expect(typeof v[0].message).toBe('string')
  })

  it('flags a non-numeric field', () => {
    const v = lintFootprintClaim({ files: 'nine' as unknown as number, new_files: 2, loc: 750, new_deps: 0, tolerance_pct: 50 })
    expect(v.some((x) => x.field === 'files')).toBe(true)
  })

  it('flags tolerance_pct outside 0..200', () => {
    expect(lintFootprintClaim({ files: 1, new_files: 0, loc: 1, new_deps: 0, tolerance_pct: 250 }).some((x) => x.field === 'tolerance_pct')).toBe(true)
    expect(lintFootprintClaim({ files: 1, new_files: 0, loc: 1, new_deps: 0, tolerance_pct: -5 }).some((x) => x.field === 'tolerance_pct')).toBe(true)
  })
})

// ── Test 3 — actuals from a FAKE execGit ─────────────────────────────────────
describe('footprint — footprintActuals (Test 3)', () => {
  function fakeExecGit(args: string[]): string {
    const joined = args.join(' ')
    if (args[0] === 'log') {
      // two commits, newest first; a binary row ('-') must be skipped from loc.
      return ['commit aaa2222', '5\t2\tsrc/a.js', '-\t-\tbin/logo.png', 'commit aaa1111', '10\t0\tsrc/b.js'].join('\n')
    }
    if (args[0] === 'show' && joined.includes('aaa1111^:package.json')) {
      return JSON.stringify({ dependencies: { 'left-pad': '1.0.0' } })
    }
    if (args[0] === 'show' && joined.includes('aaa2222:package.json')) {
      return JSON.stringify({ dependencies: { 'left-pad': '1.0.0', 'new-dep': '2.0.0' } })
    }
    throw new Error('unexpected git call: ' + joined)
  }

  it('folds log + numstat into files/loc/new_deps/commits', () => {
    const a = footprintActuals({ planId: '49.4-07', execGit: fakeExecGit })
    expect(a.empty).toBe(false)
    expect(a.commits).toBe(2)
    expect(a.loc).toBe(15) // 5 + 10; binary '-' skipped
    expect(a.files).toBe(3) // src/a.js, bin/logo.png, src/b.js
    expect(a.new_deps).toBe(1) // new-dep added between oldest-parent and newest
  })

  it('returns empty when no commits match the plan id', () => {
    const a = footprintActuals({ planId: 'nope', execGit: () => '' })
    expect(a.empty).toBe(true)
  })
})

// ── Test 4 — receipt verdict ─────────────────────────────────────────────────
describe('footprint — footprintReceipt (Test 4)', () => {
  const claim = { files: 5, new_files: 1, loc: 100, new_deps: 0, tolerance_pct: 50 } // ceilings: files 7, loc 150

  it('verifies within tolerance and calls nothing', () => {
    const appendVerdict = vi.fn()
    const draftLesson = vi.fn()
    const res = footprintReceipt({
      claim,
      actuals: { empty: false, files: 5, loc: 140, new_deps: 0 },
      planId: '49.4-07',
      planPath: 'p-PLAN.md',
      appendVerdict,
      draftLesson,
    })
    expect(res.verdict).toBe('verified')
    expect(appendVerdict).not.toHaveBeenCalled()
    expect(draftLesson).not.toHaveBeenCalled()
  })

  it('flags an loc overrun beyond tolerance and consumes both seams once', () => {
    const appendVerdict = vi.fn()
    const draftLesson = vi.fn(() => ({ drafted: true, path: '/tmp/x.md' }))
    const res = footprintReceipt({
      claim,
      actuals: { empty: false, files: 5, loc: 300, new_deps: 0 },
      planId: '49.4-07',
      planPath: 'p-PLAN.md',
      appendVerdict,
      draftLesson,
    })
    expect(res.verdict).toBe('overrun')
    expect(res.axis).toBe('loc')
    expect(appendVerdict).toHaveBeenCalledTimes(1)
    expect(draftLesson).toHaveBeenCalledTimes(1)
    const row = appendVerdict.mock.calls[0][0]
    expect(row).toMatchObject({ verdict: 'miss', domain: 'sma.economy', metric: 'footprint_overrun', id: 'FOOT-49.4-07', comparator: '<=' })
  })

  it('treats new_deps with tolerance 0 (a single extra dep is an overrun)', () => {
    const appendVerdict = vi.fn()
    const res = footprintReceipt({
      claim,
      actuals: { empty: false, files: 5, loc: 100, new_deps: 1 },
      planId: '49.4-07',
      planPath: 'p-PLAN.md',
      appendVerdict,
      draftLesson: vi.fn(() => ({ path: null })),
    })
    expect(res.verdict).toBe('overrun')
    expect(res.axis).toBe('new_deps')
  })

  it('returns honest empty for empty actuals with no verdict', () => {
    const appendVerdict = vi.fn()
    const res = footprintReceipt({ claim, actuals: { empty: true }, planId: '49.4-07', appendVerdict })
    expect(res.empty).toBe(true)
    expect(res.verdict).toBeNull()
    expect(appendVerdict).not.toHaveBeenCalled()
  })
})

// ── Test 5 — standing toggle over the grill ledger ───────────────────────────
describe('grill — standingFootprint (Test 5)', () => {
  const roots: string[] = []
  function tmpGrill(): string {
    const root = mkdtempSync(join(tmpdir(), 'sma-foot-t5-'))
    roots.push(root)
    return join(root, 'grill')
  }
  afterEach(() => {
    for (const r of roots.splice(0)) {
      try {
        rmSync(r, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        /* best-effort */
      }
    }
  })

  it('registers ONE challenge for a no-claim plan and blocks the gate (idempotent)', () => {
    const grillDir = tmpGrill()
    const r1 = standingFootprint({ planPath: 'no-PLAN.md', planId: 'z-01', claim: null, grillDir })
    expect(r1.action).toBe('registered')
    expect(grillGate({ planId: 'z-01', dirs: { grillDir } })).toMatchObject({ allowed: false, grilled: true })
    // idempotent — no duplicate
    const r2 = standingFootprint({ planPath: 'no-PLAN.md', planId: 'z-01', claim: null, grillDir })
    expect(r2.action).toBe('already-open')
    expect(readChallenges({ planId: 'z-01' }, { grillDir }).challenges).toHaveLength(1)
  })

  it('resolves the standing challenge when a claim is present (gate allows)', () => {
    const grillDir = tmpGrill()
    standingFootprint({ planPath: 'p-PLAN.md', planId: 'z-02', claim: null, grillDir })
    expect(grillGate({ planId: 'z-02', dirs: { grillDir } }).allowed).toBe(false)
    const claim = { files: 5, new_files: 1, loc: 100, new_deps: 0, tolerance_pct: 50 }
    const r = standingFootprint({ planPath: 'p-PLAN.md', planId: 'z-02', claim, grillDir })
    expect(r.action).toBe('resolved')
    expect(grillGate({ planId: 'z-02', dirs: { grillDir } }).allowed).toBe(true)
  })

  it('leaves a never-touched plan ungrilled and a claim-present plan a no-op', () => {
    const grillDir = tmpGrill()
    expect(grillGate({ planId: 'z-03', dirs: { grillDir } })).toMatchObject({ grilled: false })
    const claim = { files: 5, new_files: 1, loc: 100, new_deps: 0, tolerance_pct: 50 }
    const r = standingFootprint({ planPath: 'p-PLAN.md', planId: 'z-03', claim, grillDir })
    expect(r.action).toBe('no-op')
    expect(grillGate({ planId: 'z-03', dirs: { grillDir } })).toMatchObject({ grilled: false })
  })
})
