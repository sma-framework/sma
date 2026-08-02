/**
 * Tests for scripts/sma/lib/package-check.mjs (9.4, v3.6 — the npm
 * publishability gate + the version single-source law).
 *
 * The load-bearing behaviors:
 *   Test 1 — the REAL repo is publishable: applicable, ZERO violations (this is the
 *            publishability receipt running inside the suite)
 *   Test 2 — each violation class detected via fake io: private flag, version split,
 *            missing bin, missing files[] entry, missing metadata
 *   Test 3 — honest sentinel: a tree without capability.json is NOT applicable
 *            (the consumer mirror must never fake a 0)
 *   Test 5 — the vendored daemon ledger reaches this count: a generated section
 *            that no longer describes `daemon/node_modules`, and a vendored
 *            license outside the allowlist, are both publishability violations
 */

import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { checkPackage } from '../lib/package-check.mjs'
import { applyToFile, renderSection } from '../lib/daemon-licenses.mjs'

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

describe('package-check — the badge law, and only the badge law (Test 4)', () => {
  const ROOT = 'C:\\pkg'
  function io(receipt: object, badge = 1866) {
    const files = new Map<string, string>([
      [resolve(ROOT, 'package.json'), JSON.stringify({ version: '3.6.0', license: 'MIT', repository: { url: 'x' }, files: ['bin'] })],
      [resolve(ROOT, 'sma-core', 'capabilities', 'sma', 'capability.json'), JSON.stringify({ version: '3.6.0' })],
      [resolve(ROOT, 'README.md'), `<img src="https://img.shields.io/badge/tests-${badge}%2F${badge}-3CC0A0" alt="tests ${badge}/${badge}">`],
      [resolve(ROOT, 'test-receipt.json'), JSON.stringify(receipt)],
      [resolve(ROOT, 'bin'), ''],
    ])
    return {
      exists: (p: string) => files.has(resolve(p)),
      readFile: (p: string) => {
        const v = files.get(resolve(p))
        if (v === undefined) throw new Error('ENOENT')
        return v
      },
    }
  }

  it('flags a badge that disagrees with the receipt, and nothing about its freshness', () => {
    // Publishability must not depend on git: a receipt measured at some other commit
    // (or carrying no provenance at all) is a badge --check concern, never a violation
    // here — this count is the scorer contract and must not grow behind its back.
    expect(checkPackage({ pkgRoot: ROOT, io: io({ tests: 1866, files: 116 }) }).violations).toEqual([])
    expect(checkPackage({ pkgRoot: ROOT, io: io({ tests: 1866, files: 116, commit: 'a'.repeat(40), dirty: true }) }).violations).toEqual([])
    const stale = checkPackage({ pkgRoot: ROOT, io: io({ tests: 1880, files: 116 }) })
    expect(stale.violations.map((v: { code: string }) => v.code)).toEqual(['badge-stale'])
  })
})

describe('package-check — the vendored daemon ledger (Test 5)', () => {
  const ROOT = 'C:\\pkg'
  const VENDORED = [{ name: 'pg-fake', version: '1.2.3', license: 'MIT' }]
  const MODULES = resolve(ROOT, 'daemon', 'node_modules')

  function io(licensesText: string) {
    const files = new Map<string, string>([
      [resolve(ROOT, 'package.json'), JSON.stringify({ version: '3.6.0', license: 'MIT', repository: { url: 'x' }, files: [] })],
      [resolve(ROOT, 'sma-core', 'capabilities', 'sma', 'capability.json'), JSON.stringify({ version: '3.6.0' })],
      [resolve(ROOT, 'THIRD-PARTY-LICENSES.md'), licensesText],
      [resolve(MODULES, 'pg-fake', 'package.json'), JSON.stringify(VENDORED[0])],
    ])
    const dirs = new Map<string, string[]>([[MODULES, ['pg-fake']]])
    return {
      exists: (p: string) => files.has(resolve(p)) || dirs.has(resolve(p)),
      readFile: (p: string) => {
        const v = files.get(resolve(p))
        if (v === undefined) throw new Error('ENOENT')
        return v
      },
      readdir: (p: string) => {
        const v = dirs.get(resolve(p))
        if (v === undefined) throw new Error('ENOTDIR')
        return v
      },
    }
  }

  it('counts a stale generated section as a publishability violation, and a current one as none', () => {
    const current = applyToFile('# Third-Party Licenses\n', renderSection(VENDORED))
    expect(checkPackage({ pkgRoot: ROOT, io: io(current) }).violations).toEqual([])
    const stale = checkPackage({ pkgRoot: ROOT, io: io(current.replace('1.2.3', '1.2.4')) })
    expect(stale.violations.map((v: { code: string }) => v.code)).toEqual(['daemon-licenses-stale'])
  })

  it('counts a vendored license outside the allowlist as a publishability violation', () => {
    const copyleft = [{ name: 'pg-fake', version: '1.2.3', license: 'GPL-3.0' }]
    const files = io(applyToFile('# Third-Party Licenses\n', renderSection(copyleft)))
    const readFile = (p: string) =>
      resolve(p) === resolve(MODULES, 'pg-fake', 'package.json') ? JSON.stringify(copyleft[0]) : files.readFile(p)
    const res = checkPackage({ pkgRoot: ROOT, io: { ...files, readFile } })
    expect(res.violations.map((v: { code: string }) => v.code)).toEqual(['daemon-license-forbidden'])
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
