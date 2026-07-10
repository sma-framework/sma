/**
 * Tests for scripts/sma/lib/package-check.mjs (49.4 BL-163/BL-164, v3.6 — the npm
 * publishability gate + the version single-source law).
 *
 * The load-bearing behaviors:
 *   Test 1 — the REAL repo is publishable: applicable, ZERO violations (this is the
 *            R-BL-163 receipt running inside the suite)
 *   Test 2 — each violation class detected via fake io: private flag, version split,
 *            missing bin, missing files[] entry, missing metadata
 *   Test 3 — honest sentinel: a tree without capability.json is NOT applicable
 *            (the platform mirror must never fake a 0)
 */

import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { checkPackage } from '../lib/package-check.mjs'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')

describe('package-check — the real repo (Test 1)', () => {
  it('is applicable and has ZERO violations (publishable tarball)', () => {
    const res = checkPackage({ pkgRoot: REPO_ROOT })
    expect(res.applicable).toBe(true)
    expect(res.violations).toEqual([])
  })
})

describe('package-check — violation classes (Test 2)', () => {
  const ROOT = 'C:\\pkg'
  function io(pkg: object, cap: object = { version: '3.6.0' }, present: string[] = []) {
    const files = new Map<string, string>([
      [resolve(ROOT, 'package.json'), JSON.stringify(pkg)],
      [resolve(ROOT, 'sma-core', 'capabilities', 'sma', 'capability.json'), JSON.stringify(cap)],
    ])
    const disk = new Set(present.map((p) => resolve(ROOT, p)))
    return {
      exists: (p: string) => files.has(resolve(p)) || disk.has(resolve(p)),
      readFile: (p: string) => {
        const v = files.get(resolve(p))
        if (v === undefined) throw new Error('ENOENT')
        return v
      },
    }
  }
  const GOOD = {
    version: '3.6.0',
    license: 'MIT',
    repository: { url: 'x' },
    bin: { sma: 'bin/init.mjs' },
    files: ['bin'],
  }

  it('flags private, version split, missing bin, missing files entry, missing metadata', () => {
    const cases: Array<[object, string]> = [
      [{ ...GOOD, private: true }, 'private-flag'],
      [{ ...GOOD, version: '3.5.0' }, 'version-split'],
      [{ ...GOOD, bin: { sma: 'bin/nope.mjs' } }, 'bin-missing'],
      [{ ...GOOD, files: ['bin', 'ghost-dir'] }, 'files-missing'],
      [{ ...GOOD, repository: undefined }, 'no-repository'],
      [{ ...GOOD, license: undefined }, 'no-license'],
    ]
    for (const [pkg, code] of cases) {
      const res = checkPackage({ pkgRoot: ROOT, io: io(pkg, { version: '3.6.0' }, ['bin', 'bin/init.mjs']) })
      expect(res.applicable).toBe(true)
      expect(res.violations.map((v) => v.code)).toContain(code)
    }
    const clean = checkPackage({ pkgRoot: ROOT, io: io(GOOD, { version: '3.6.0' }, ['bin', 'bin/init.mjs']) })
    expect(clean.violations).toEqual([])
  })
})

describe('package-check — honest sentinel (Test 3)', () => {
  it('a tree without capability.json is not applicable, never a fake 0', () => {
    const res = checkPackage({
      pkgRoot: 'C:\\not-the-product',
      io: { exists: () => false, readFile: () => '' },
    })
    expect(res.applicable).toBe(false)
  })
})
