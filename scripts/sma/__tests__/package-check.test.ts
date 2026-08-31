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
 *   Test 6 — the WINDOW ledger reaches it the same way: the bundle ships other
 *            people's code compiled, so a window section that no longer matches
 *            `spa/package-lock.json`, and a bundled license outside the
 *            allowlist, are publishability violations too
 */

import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { checkPackage } from '../lib/package-check.mjs'
import { applySpaToFile, applyToFile, renderSection, renderSpaSection, scanSpaPackages } from '../lib/daemon-licenses.mjs'

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
  function io(pkg: object, cap: object = { version: '3.6.0' }, present: string[] = [], contents: Record<string, string> = {}) {
    const files = new Map<string, string>([
      [resolve(ROOT, 'package.json'), JSON.stringify(pkg)],
      [resolve(ROOT, 'sma-core', 'capabilities', 'sma', 'capability.json'), JSON.stringify(cap)],
      ...Object.entries(contents).map(([p, text]) => [resolve(ROOT, p), text] as [string, string]),
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

  /**
   * THE WINDOW HAS TO BE IN THE TARBALL.
   *
   * `daemon/static/app/` is gitignored on purpose — a 480 KB minified artefact in every diff
   * is worse than rebuilding it — and `files[]` packs `daemon/` whole, FROM DISK. Those two
   * facts together decide what a published release actually contains: the right window, or
   * none at all. In the second case somebody who has just installed a release opens the app
   * and is told to go and build one.
   *
   * The sentinel is the other half of the rule: only a tree that HAS the window's source is
   * asked for its output. An installed copy, or a mirror of scripts/sma, never had a `spa/`
   * and must not be failed for a bundle it was never meant to produce.
   */
  const BASE = ['bin', 'bin/init.mjs']

  /**
   * A window source is more than a directory: it carries the lockfile the licence
   * ledger reads, and the ledger's committed section has to match it. This builds
   * a `spa/` that is complete in that sense, so the bundle tests below measure the
   * bundle rule and nothing else.
   */
  const SPA_FILES = {
    'spa/package.json': JSON.stringify({ name: 'sma-spa', dependencies: {} }),
    'spa/package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: {} }, 'node_modules/tailwindcss': { version: '4.3.3', license: 'MIT' } },
    }),
  }
  function withWindowSource(present: string[]) {
    const probe = io(GOOD, { version: '3.6.0' }, present, SPA_FILES)
    const section = renderSpaSection(scanSpaPackages(ROOT, { io: probe }))
    return io(GOOD, { version: '3.6.0' }, present, {
      ...SPA_FILES,
      'THIRD-PARTY-LICENSES.md': applySpaToFile('# Third-Party Licenses\n', section),
    })
  }

  it('flags a package that would ship without the window', () => {
    const res = checkPackage({ pkgRoot: ROOT, io: withWindowSource(BASE) })
    expect(res.violations.map((v) => v.code)).toEqual(['bundle-missing'])
    // the message has to say what to DO, not only what is wrong
    expect(res.violations.find((v) => v.code === 'bundle-missing')?.detail).toContain('build:spa')
  })

  it('is satisfied once the window is built', () => {
    const res = checkPackage({ pkgRoot: ROOT, io: withWindowSource([...BASE, 'daemon/static/app/index.html']) })
    expect(res.violations).toEqual([])
  })

  it('never asks a tree without a window source for a window', () => {
    // no spa/ at all — an installed copy. Absence of the bundle is not a violation there.
    const res = checkPackage({ pkgRoot: ROOT, io: io(GOOD, { version: '3.6.0' }, BASE) })
    expect(res.violations.map((v) => v.code)).not.toContain('bundle-missing')
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

  it('REFUSES a receipt measured on a dirty worktree under --strict (the release question)', () => {
    // A number measured over uncommitted files counts something nobody can name or
    // reproduce, and a release is exactly where that stops being tolerable. The flag is
    // in the receipt, so the gate reaches this verdict with no git anywhere near it —
    // and the bare count above stays the number the scorer has always read.
    const receipt = { tests: 1866, files: 116, commit: 'a'.repeat(40), dirty: true }
    const gated = checkPackage({ pkgRoot: ROOT, io: io(receipt), strict: true })
    expect(gated.violations.map((v: { code: string }) => v.code)).toEqual(['badge-receipt-dirty'])
    expect(gated.violations[0].detail).toMatch(/commit first/)
    // measured on a committed tree, the same receipt passes the same gate
    expect(checkPackage({ pkgRoot: ROOT, io: io({ ...receipt, dirty: false }), strict: true }).violations).toEqual([])
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

describe('package-check — the window bundle ledger (Test 6)', () => {
  const ROOT = 'C:\\pkg'
  const lock = (license: string) => ({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { react: '19.2.8' } },
      'node_modules/react': { version: '19.2.8', license },
      'node_modules/tailwindcss': { version: '4.3.3', license: 'MIT' },
    },
  })

  function io(lockObj: object, licensesText?: string) {
    const files = new Map<string, string>([
      [resolve(ROOT, 'package.json'), JSON.stringify({ version: '3.6.0', license: 'MIT', repository: { url: 'x' }, files: [] })],
      [resolve(ROOT, 'sma-core', 'capabilities', 'sma', 'capability.json'), JSON.stringify({ version: '3.6.0' })],
      [resolve(ROOT, 'spa', 'package.json'), JSON.stringify({ name: 'sma-spa' })],
      [resolve(ROOT, 'spa', 'package-lock.json'), JSON.stringify(lockObj)],
      // the built window, so `bundle-missing` stays out of the way of this measurement
      [resolve(ROOT, 'daemon', 'static', 'app', 'index.html'), '<!doctype html>'],
    ])
    if (licensesText !== undefined) files.set(resolve(ROOT, 'THIRD-PARTY-LICENSES.md'), licensesText)
    return {
      exists: (p: string) => files.has(resolve(p)),
      readFile: (p: string) => {
        const v = files.get(resolve(p))
        if (v === undefined) throw new Error('ENOENT')
        return v
      },
    }
  }

  const current = (lockObj: object) =>
    applySpaToFile('# Third-Party Licenses\n', renderSpaSection(scanSpaPackages(ROOT, { io: io(lockObj) })))

  it('counts a stale window section as a publishability violation, and a current one as none', () => {
    const good = lock('MIT')
    expect(checkPackage({ pkgRoot: ROOT, io: io(good, current(good)) }).violations).toEqual([])
    const stale = checkPackage({ pkgRoot: ROOT, io: io(good, current(good).replace('19.2.8', '19.2.9')) })
    expect(stale.violations.map((v: { code: string }) => v.code)).toEqual(['spa-licenses-stale'])
  })

  it('counts a bundled license outside the allowlist as a publishability violation', () => {
    const copyleft = lock('GPL-3.0')
    const res = checkPackage({ pkgRoot: ROOT, io: io(copyleft, current(copyleft)) })
    expect(res.violations.map((v: { code: string }) => v.code)).toEqual(['spa-license-forbidden'])
    expect(res.violations[0].detail).toContain('react@19.2.8')
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
