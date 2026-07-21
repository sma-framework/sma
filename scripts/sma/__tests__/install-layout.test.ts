/**
 * Regression tests for the installed sma-core payload being SELF-CONTAINED.
 *
 * The defect: sma-core/bin/lib/command-roster.cjs did a top-level
 * `require('../../../scripts/fix-slash-commands.cjs')`. In the source tree that
 * resolves to <repo>/scripts/ (exists); in an install sma-core lands under
 * <configDir>/ (e.g. .claude/sma-core) and the same relative path points at
 * <configDir>/scripts/ — never delivered by the installer — so EVERY
 * `node .claude/sma-core/bin/sma-tools.cjs <anything>` died at require time
 * with MODULE_NOT_FOUND, killing the whole query layer in consumer installs.
 *
 * These tests copy the real sma-core/ payload into an install-shaped temp tree
 * (sma-core under .claude/, NO sibling scripts/, NO package.json) and spawn a
 * real node process against it:
 *   Test 1 — sma-tools.cjs boots from the install layout: --help exits 0 and
 *            prints usage; stderr carries no MODULE_NOT_FOUND.
 *   Test 2 — the query layer actually dispatches: `query current-timestamp date`
 *            exits 0 and returns a date, `query generate-slug` returns a slug.
 *   Test 3 — command-roster.cjs itself loads from the install layout; the
 *            roster degrades to [] without a commands/sma tree and the pure
 *            transforms still work.
 *   Test 4 — dev-tree parity: scripts/fix-slash-commands.cjs re-exports the
 *            same transforms (dependency now points dev → sma-core, not the
 *            reverse), so the one-shot walker and the runtime cannot drift.
 */

import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const require = createRequire(import.meta.url)
const repoRoot = join(__dirname, '..', '..', '..')

let tmp: string
let projDir: string
let smaTools: string
let rosterPath: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-install-layout-'))
  projDir = join(tmp, 'proj')
  mkdirSync(join(projDir, '.claude'), { recursive: true })
  // Install-shaped: ONLY the sma-core payload under .claude/ — exactly what
  // bin/init.mjs delivers. No .claude/scripts/, no package.json.
  cpSync(join(repoRoot, 'sma-core'), join(projDir, '.claude', 'sma-core'), { recursive: true })
  smaTools = join(projDir, '.claude', 'sma-core', 'bin', 'sma-tools.cjs')
  rosterPath = join(projDir, '.claude', 'sma-core', 'bin', 'lib', 'command-roster.cjs')
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function runNode(args: string[], cwd: string) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 25000 })
}

describe('install layout — sma-tools boots (Test 1)', () => {
  it('the premise holds: the install tree has no scripts/ next to sma-core', () => {
    expect(existsSync(join(projDir, '.claude', 'scripts'))).toBe(false)
  })

  it('--help exits 0 with usage, no MODULE_NOT_FOUND', () => {
    const res = runNode([smaTools, '--help'], projDir)
    expect(res.stderr ?? '').not.toContain('Cannot find module')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Usage: sma-tools')
  })
})

describe('install layout — query layer dispatches (Test 2)', () => {
  it('query current-timestamp date returns a date', () => {
    const res = runNode([smaTools, 'query', 'current-timestamp', 'date'], projDir)
    expect(res.stderr ?? '').not.toContain('Cannot find module')
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('query generate-slug returns a slug', () => {
    const res = runNode([smaTools, 'query', 'generate-slug', 'Install Layout Works'], projDir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('install-layout-works')
  })
})

describe('install layout — command-roster is self-contained (Test 3)', () => {
  it('loads without a sibling scripts/ dir; empty roster degrades to []; transforms work', () => {
    const probe = join(tmp, 'probe.cjs')
    writeFileSync(probe, [
      'const r = require(process.argv[2]);',
      'process.stdout.write(JSON.stringify({',
      '  names: r.readSmaCommandNames(),',
      "  toHyphen: r.transformContentToHyphen('run /sma:plan-phase now', ['plan-phase']),",
      "  toColon: r.transformContent('run /sma-plan-phase now', ['plan-phase']),",
      "  emptyNoop: r.transformContentToHyphen('run /sma:plan-phase now', []),",
      '}));',
    ].join('\n'))
    const res = runNode([probe, rosterPath], projDir)
    expect(res.stderr ?? '').not.toContain('Cannot find module')
    expect(res.status).toBe(0)
    const out = JSON.parse(res.stdout)
    expect(Array.isArray(out.names)).toBe(true)
    expect(out.names).toEqual([]) // no commands/sma tree in this install shape
    expect(out.toHyphen).toBe('run /sma-plan-phase now')
    expect(out.toColon).toBe('run /sma:plan-phase now')
    expect(out.emptyNoop).toBe('run /sma:plan-phase now') // empty registry must never rewrite
  })
})

describe('source tree — dev one-shot re-exports the shared transforms (Test 4)', () => {
  it('scripts/fix-slash-commands.cjs and command-roster.cjs expose the SAME functions', () => {
    const devScript = require(join(repoRoot, 'scripts', 'fix-slash-commands.cjs'))
    const roster = require(join(repoRoot, 'sma-core', 'bin', 'lib', 'command-roster.cjs'))
    // Identity, not equivalence: a copy could drift, the same reference cannot.
    expect(devScript.transformContent).toBe(roster.transformContent)
    expect(devScript.transformContentToHyphen).toBe(roster.transformContentToHyphen)
    expect(devScript.buildPattern).toBe(roster.buildPattern)
    expect(devScript.buildColonPattern).toBe(roster.buildColonPattern)
    expect(devScript.readCmdNames).toBe(roster.readSmaCommandNames)
    expect(devScript.SKIP_DIRS).toBeInstanceOf(Set)
  })
})
