/**
 * Tests for scripts/sma/lib/daemon-licenses.mjs — the generated ledger of the
 * daemon's vendored dependencies.
 *
 * The load-bearing behaviors:
 *   Test 1 — the REAL vendored tree: every package on disk is scanned, and the
 *            section committed in THIRD-PARTY-LICENSES.md matches a fresh render
 *            BYTE for byte. This is the non-vacuous half: before the section was
 *            generated this test was red, because the file carried no section at
 *            all while the tarball carried 19 packages.
 *   Test 2 — a package whose license is outside the allowlist is a violation
 *            (and only that — a current section stays clean)
 *   Test 3 — one drifted byte in the committed section is a violation, and so is
 *            a missing section
 *   Test 4 — the SPDX expression reading: OR is a choice, AND binds, unstated is
 *            never assumed permissive
 *   Test 5 — scoped and NESTED packages are scanned, deduped by name@version
 *   Test 6 — the splice is idempotent and leaves the bytes around it alone
 *   Test 7 — honest sentinel: no vendored tree -> not applicable, never a fake 0
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  LICENSES_FILE,
  LICENSE_ALLOWLIST,
  applyToFile,
  checkDaemonLicenses,
  isAllowedLicense,
  licenseOf,
  readSection,
  renderSection,
  scanDaemonPackages,
} from '../lib/daemon-licenses.mjs'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')

type FakePkg = { name: string; version: string; license?: unknown; dirName?: string; nested?: FakePkg[] }

const ROOT = 'C:\\pkg'

/** A fake vendored tree + an optional committed licenses file. */
function io(pkgs: FakePkg[], licensesText?: string) {
  const files = new Map<string, string>()
  const dirs = new Map<string, string[]>()

  const place = (modulesDir: string, list: FakePkg[]) => {
    const entries: string[] = []
    for (const p of list) {
      const dirName = p.dirName ?? p.name
      entries.push(dirName.includes('/') ? dirName.split('/')[0] : dirName)
      const pkgDir = resolve(modulesDir, ...dirName.split('/'))
      files.set(resolve(pkgDir, 'package.json'), JSON.stringify({ name: p.name, version: p.version, license: p.license }))
      if (dirName.includes('/')) {
        const scope = resolve(modulesDir, dirName.split('/')[0])
        dirs.set(scope, [...(dirs.get(scope) ?? []), dirName.split('/')[1]])
      }
      if (p.nested) place(resolve(pkgDir, 'node_modules'), p.nested)
    }
    dirs.set(modulesDir, [...new Set([...(dirs.get(modulesDir) ?? []), ...entries])])
  }
  place(resolve(ROOT, 'daemon', 'node_modules'), pkgs)
  if (licensesText !== undefined) files.set(resolve(ROOT, LICENSES_FILE), licensesText)

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

/** The section a fixture tree SHOULD carry — rendered, then spliced into a file. */
function currentFile(pkgs: FakePkg[]) {
  return applyToFile('# Third-Party Licenses\n', renderSection(scanDaemonPackages(ROOT, { io: io(pkgs) })))
}

const codes = (res: { violations: Array<{ code: string }> }) => res.violations.map((v) => v.code)

describe('daemon-licenses — the real vendored tree (Test 1)', () => {
  it('scans every vendored package and the committed section matches byte for byte', () => {
    const packages = scanDaemonPackages(REPO_ROOT)
    // The tarball ships pg + pg-boss and their transitive tree; the count is a
    // floor, not an equality, so adding a dependency does not break this test —
    // it breaks the parity assertion below until the section is regenerated.
    expect(packages.length).toBeGreaterThanOrEqual(19)
    expect(packages.map((p) => p.name)).toEqual(expect.arrayContaining(['pg', 'pg-boss']))
    for (const p of packages) {
      expect(p.version).toMatch(/^\d+\.\d+/)
      expect(String(p.license).trim().length).toBeGreaterThan(0)
    }

    const committed = readSection(readFileSync(join(REPO_ROOT, LICENSES_FILE), 'utf8'))
    expect(committed).toBe(renderSection(packages))
  })

  it('has zero violations against the real tree (the shipped ledger is current and permissive)', () => {
    const res = checkDaemonLicenses({ pkgRoot: REPO_ROOT })
    expect(res.applicable).toBe(true)
    expect(res.violations).toEqual([])
    expect(res.packages.every((p) => isAllowedLicense(p.license))).toBe(true)
  })
})

describe('daemon-licenses — a license outside the allowlist (Test 2)', () => {
  const pkgs: FakePkg[] = [
    { name: 'fine', version: '1.0.0', license: 'MIT' },
    { name: 'copyleft', version: '2.0.0', license: 'GPL-3.0' },
  ]

  it('flags the package and nothing else when the section itself is current', () => {
    const res = checkDaemonLicenses({ pkgRoot: ROOT, io: io(pkgs, currentFile(pkgs)) })
    expect(res.applicable).toBe(true)
    expect(codes(res)).toEqual(['daemon-license-forbidden'])
    expect(res.violations[0].detail).toContain('copyleft@2.0.0')
  })

  it('flags a package that states no license at all', () => {
    const unstated: FakePkg[] = [{ name: 'silent', version: '1.0.0' }]
    const res = checkDaemonLicenses({ pkgRoot: ROOT, io: io(unstated, currentFile(unstated)) })
    expect(codes(res)).toEqual(['daemon-license-forbidden'])
    expect(res.violations[0].detail).toContain('UNKNOWN')
  })
})

describe('daemon-licenses — the section must match the disk (Test 3)', () => {
  const pkgs: FakePkg[] = [
    { name: 'alpha', version: '1.0.0', license: 'MIT' },
    { name: 'beta', version: '2.3.4', license: 'ISC' },
  ]

  it('flags ONE drifted byte in the committed section', () => {
    const drifted = currentFile(pkgs).replace('2.3.4', '2.3.5')
    expect(codes(checkDaemonLicenses({ pkgRoot: ROOT, io: io(pkgs, drifted) }))).toEqual(['daemon-licenses-stale'])
  })

  it('flags a package that is on disk but missing from the table', () => {
    const short = currentFile([pkgs[0]])
    expect(codes(checkDaemonLicenses({ pkgRoot: ROOT, io: io(pkgs, short) }))).toEqual(['daemon-licenses-stale'])
  })

  it('flags a licenses file with no generated section at all', () => {
    expect(codes(checkDaemonLicenses({ pkgRoot: ROOT, io: io(pkgs, '# Third-Party Licenses\n') }))).toEqual(['daemon-licenses-stale'])
  })

  it('is quiet when the section is current', () => {
    expect(checkDaemonLicenses({ pkgRoot: ROOT, io: io(pkgs, currentFile(pkgs)) }).violations).toEqual([])
  })
})

describe('daemon-licenses — reading an SPDX expression (Test 4)', () => {
  it('takes OR as a choice, AND as a binding, and never assumes the unstated', () => {
    for (const id of LICENSE_ALLOWLIST) expect(isAllowedLicense(id)).toBe(true)
    expect(isAllowedLicense('(MIT OR CC0-1.0)')).toBe(true) // type-fest's real expression
    expect(isAllowedLicense('MIT AND ISC')).toBe(true)
    expect(isAllowedLicense('MIT AND GPL-3.0')).toBe(false)
    expect(isAllowedLicense('GPL-3.0')).toBe(false)
    expect(isAllowedLicense('UNKNOWN')).toBe(false)
    expect(isAllowedLicense('')).toBe(false)
    expect(isAllowedLicense(undefined)).toBe(false)
  })

  it('reads all three manifest license shapes, and refuses to invent one', () => {
    expect(licenseOf({ license: 'MIT' })).toBe('MIT')
    expect(licenseOf({ license: { type: 'ISC' } })).toBe('ISC')
    expect(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
    expect(licenseOf({})).toBe('UNKNOWN')
  })
})

describe('daemon-licenses — scoped and nested packages (Test 5)', () => {
  it('walks scopes and nested node_modules, sorted by name and deduped by version', () => {
    const packages = scanDaemonPackages(ROOT, {
      io: io([
        { name: 'zebra', version: '1.0.0', license: 'MIT' },
        { name: '@scope/inner', version: '0.2.0', license: 'MIT', dirName: '@scope/inner' },
        {
          name: 'outer',
          version: '3.0.0',
          license: 'MIT',
          nested: [
            { name: 'deep', version: '9.9.9', license: 'ISC' },
            { name: 'zebra', version: '1.0.0', license: 'MIT' }, // same name@version, one row
          ],
        },
      ]),
    })
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      '@scope/inner@0.2.0',
      'deep@9.9.9',
      'outer@3.0.0',
      'zebra@1.0.0',
    ])
    // The render follows the scan: sorted, one row per package, no duplicates.
    const rows = renderSection(packages).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Package'))
    expect(rows.length).toBe(4)
  })
})

describe('daemon-licenses — the splice (Test 6)', () => {
  it('is idempotent and leaves the surrounding bytes untouched', () => {
    const before = '# Third-Party Licenses\n\nprose above\n'
    const rendered = renderSection([{ name: 'alpha', version: '1.0.0', license: 'MIT' }])
    const once = applyToFile(before, rendered)
    const twice = applyToFile(once, rendered)
    expect(twice).toBe(once)
    expect(once.startsWith(before)).toBe(true)
    expect(readSection(once)).toBe(rendered)

    const regenerated = applyToFile(once, renderSection([{ name: 'alpha', version: '1.0.1', license: 'MIT' }]))
    expect(regenerated.startsWith(before)).toBe(true)
    expect(readSection(regenerated)).toContain('1.0.1')
    expect(readSection(regenerated)).not.toContain('1.0.0')
  })

  it('reads no section out of a file that has none', () => {
    expect(readSection('# nothing generated here\n')).toBe(null)
  })
})

describe('daemon-licenses — honest sentinel (Test 7)', () => {
  it('a tree with no vendored daemon is not applicable, never a fake 0', () => {
    const res = checkDaemonLicenses({
      pkgRoot: 'C:\\not-the-product',
      io: { exists: () => false, readFile: () => '', readdir: () => [] },
    })
    expect(res.applicable).toBe(false)
    expect(res.violations).toEqual([])
    expect(res.packages).toEqual([])
  })

  it('an io without readdir produces no verdict rather than a crash', () => {
    const res = checkDaemonLicenses({ pkgRoot: ROOT, io: { exists: () => true, readFile: () => '' } })
    expect(res.applicable).toBe(false)
    expect(res.violations).toEqual([])
  })
})
