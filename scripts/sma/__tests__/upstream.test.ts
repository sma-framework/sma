/**
 * Tests for scripts/sma/lib/upstream.mjs (Phase 49.1 Plan 07, Task 1 — D-49.1-03).
 *
 * Daily upstream-watch mechanic:
 *   - Test 1: checkVersion anchor 1.6.1 vs registry 1.6.1 -> { status: 'current' }
 *   - Test 2: anchor 1.6.1 vs registry 1.7.0 -> { status: 'new', latest: '1.7.0' }
 *   - Test 3: threeWayReport over fixture trees — changed ONLY upstream -> 'clean';
 *     changed in BOTH -> 'conflict'; upstream paths mapped through rename-map
 *     (files + ordered strings) before comparing against ours.
 *   - Test 4: applyCleanSet dryRun default writes NOTHING; apply:true writes only
 *     the clean bucket (conflict files never touched).
 *   - Test 5: registry unreachable -> { status: 'unknown', error } — fail-open,
 *     never throws.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { checkVersion, threeWayReport, applyCleanSet, renderReport } from '../lib/upstream.mjs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-upstream-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write a file, creating parent dirs. */
function put(base: string, rel: string, content: string) {
  const p = join(base, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}

function writeAnchor(version: string): string {
  return put(root, 'UPSTREAM.json', JSON.stringify({ package: '@opengsd/gsd-core', version }))
}

// Minimal rename-map fixture mirroring the real map's shape: one explicit file
// rename (with the sma-core/ tree prefix, as in the real map) + ordered strings.
const RENAME_MAP = {
  files: [{ from: 'sma-core/bin/gsd-tools.cjs', to: 'sma-core/bin/sma-tools.cjs' }],
  strings: [
    { from: 'gsd-core', to: 'sma-core' },
    { from: 'gsd', to: 'sma' },
  ],
}

describe('checkVersion', () => {
  it('Test 1: anchor 1.6.1 + registry 1.6.1 -> status current', async () => {
    const anchorPath = writeAnchor('1.6.1')
    const res = await checkVersion({ anchorPath, fetchVersion: async () => '1.6.1' })
    expect(res.status).toBe('current')
    expect(res.anchor).toBe('1.6.1')
  })

  it('Test 2: anchor 1.6.1 + registry 1.7.0 -> status new + latest', async () => {
    const anchorPath = writeAnchor('1.6.1')
    const res = await checkVersion({ anchorPath, fetchVersion: async () => '1.7.0' })
    expect(res.status).toBe('new')
    expect(res.latest).toBe('1.7.0')
  })

  it('Test 5: registry unreachable -> status unknown + error, never throws', async () => {
    const anchorPath = writeAnchor('1.6.1')
    const res = await checkVersion({
      anchorPath,
      fetchVersion: async () => {
        throw new Error('ENOTFOUND registry.npmjs.org')
      },
    })
    expect(res.status).toBe('unknown')
    expect(String(res.error)).toContain('ENOTFOUND')
  })
})

describe('threeWayReport', () => {
  function buildFixture() {
    const vendorBaseDir = join(root, 'vendor-base')
    const newUpstreamDir = join(root, 'new-upstream')
    const oursDir = join(root, 'ours')

    // vendor base (their old)
    put(vendorBaseDir, 'workflows/plan.md', 'run gsd plan\n')
    put(vendorBaseDir, 'bin/gsd-tools.cjs', '// gsd tools v1\n')

    // new upstream (their new): BOTH files changed upstream
    put(newUpstreamDir, 'workflows/plan.md', 'run gsd plan v2\n')
    put(newUpstreamDir, 'bin/gsd-tools.cjs', '// gsd tools v2\n')

    // ours: plan.md is the string-mapped vendor base (unchanged by us -> clean);
    // sma-tools.cjs was locally patched (changed in both -> conflict).
    put(oursDir, 'workflows/plan.md', 'run sma plan\n')
    put(oursDir, 'bin/sma-tools.cjs', '// sma tools v1 LOCALLY PATCHED\n')

    return { vendorBaseDir, newUpstreamDir, oursDir }
  }

  it('Test 3: upstream-only change -> clean; changed-in-both -> conflict; paths rename-mapped', () => {
    const { vendorBaseDir, newUpstreamDir, oursDir } = buildFixture()
    const report = threeWayReport({ vendorBaseDir, newUpstreamDir, oursDir, renameMap: RENAME_MAP })

    const cleanPaths = report.clean.map((e: any) => e.ourPath)
    const conflictPaths = report.conflict.map((e: any) => e.ourPath)

    expect(cleanPaths).toContain('workflows/plan.md')
    // explicit files[] entry mapped bin/gsd-tools.cjs -> bin/sma-tools.cjs
    expect(conflictPaths).toContain('bin/sma-tools.cjs')
    expect(report.summary.clean).toBe(1)
    expect(report.summary.conflict).toBe(1)
    // clean entry carries the mapped new-upstream content (what apply would write)
    const clean = report.clean.find((e: any) => e.ourPath === 'workflows/plan.md')
    expect(clean.content).toBe('run sma plan v2\n')
  })

  it('Test 4: applyCleanSet dryRun default writes nothing; apply:true writes clean only', () => {
    const { vendorBaseDir, newUpstreamDir, oursDir } = buildFixture()
    const report = threeWayReport({ vendorBaseDir, newUpstreamDir, oursDir, renameMap: RENAME_MAP })

    // dryRun (default): NOTHING written
    const dry = applyCleanSet({ report, oursDir })
    expect(dry.dryRun).toBe(true)
    expect(dry.applied).toEqual([])
    expect(readFileSync(join(oursDir, 'workflows/plan.md'), 'utf8')).toBe('run sma plan\n')
    expect(readFileSync(join(oursDir, 'bin/sma-tools.cjs'), 'utf8')).toBe('// sma tools v1 LOCALLY PATCHED\n')

    // apply:true — clean bucket written, conflict untouched
    const res = applyCleanSet({ report, oursDir, apply: true })
    expect(res.dryRun).toBe(false)
    expect(res.applied).toContain('workflows/plan.md')
    expect(readFileSync(join(oursDir, 'workflows/plan.md'), 'utf8')).toBe('run sma plan v2\n')
    expect(readFileSync(join(oursDir, 'bin/sma-tools.cjs'), 'utf8')).toBe('// sma tools v1 LOCALLY PATCHED\n')
  })

  it('renderReport: markdown lists clean + conflict buckets and the divergence note', () => {
    const { vendorBaseDir, newUpstreamDir, oursDir } = buildFixture()
    const report = threeWayReport({ vendorBaseDir, newUpstreamDir, oursDir, renameMap: RENAME_MAP })
    const md = renderReport({ report, version: '1.7.0', anchor: '1.6.1' })
    expect(md).toContain('workflows/plan.md')
    expect(md).toContain('bin/sma-tools.cjs')
    expect(md).toContain('1.7.0')
    // honest divergence note: bigger manual bucket = further divergence
    expect(md.toLowerCase()).toContain('divergence')
  })
})
