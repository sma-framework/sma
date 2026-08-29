/**
 * Tests for scripts/sma/lib/daemon-licenses.mjs — the generated ledger of the
 * code this package hands over: the daemon's vendored tree AND the window's
 * built bundle.
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
 *   Test 8 — the REAL window: «the list equals the fact». Every declared window
 *            dependency and every transitive it pulls is named, nothing that is
 *            neither reachable nor a declared emitter is, and the committed
 *            section matches a fresh render byte for byte. Non-vacuous the same
 *            way Test 1 was: the file used to name none of react, react-dom,
 *            @tanstack/react-query or tailwind while shipping all four.
 *   Test 9 — the closure rule: transitives ride, devDependencies do not, a
 *            `dev:true` resolution is skipped, a nested duplicate wins over the
 *            hoisted one
 *  Test 10 — the window gate: drift, a forbidden license, a missing lockfile,
 *            and the narrow sentinel (no `spa/` -> not applicable)
 *  Test 11 — the notices claim is MEASURED: against a real build on disk, the
 *            CSS keeps its legal comment and the JS keeps no copyright line —
 *            exactly what the ledger says in words
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  LICENSES_FILE,
  LICENSE_ALLOWLIST,
  SPA_EMITTED_BY_BUILD,
  applySpaToFile,
  applyToFile,
  checkDaemonLicenses,
  checkSpaLicenses,
  isAllowedLicense,
  licenseOf,
  readSection,
  readSpaSection,
  renderSection,
  renderSpaSection,
  scanDaemonPackages,
  scanSpaPackages,
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

// ── the window bundle half ────────────────────────────────────────────────────

type LockEntry = { version?: string; license?: unknown; dev?: boolean; dependencies?: Record<string, string> }
type Lock = { lockfileVersion: number; packages: Record<string, LockEntry & { devDependencies?: Record<string, string> }> }

/** A fake `spa/` — manifest, lockfile, and optionally a committed licenses file. */
function spaIo(lock: unknown, licensesText?: string, present: { manifest?: boolean; lockfile?: boolean } = {}) {
  const files = new Map<string, string>()
  if (present.manifest !== false) files.set(resolve(ROOT, 'spa', 'package.json'), JSON.stringify({ name: 'sma-spa' }))
  // a raw string is written verbatim, so a test can hand over an unparseable lockfile
  if (present.lockfile !== false) {
    files.set(resolve(ROOT, 'spa', 'package-lock.json'), typeof lock === 'string' ? lock : JSON.stringify(lock))
  }
  if (licensesText !== undefined) files.set(resolve(ROOT, LICENSES_FILE), licensesText)
  return {
    exists: (p: string) => files.has(resolve(p)),
    readFile: (p: string) => {
      const v = files.get(resolve(p))
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    readdir: () => {
      throw new Error('ENOTDIR') // the window half never walks a tree — it reads the lockfile
    },
  }
}

/** The window section a fixture lockfile SHOULD carry, spliced into a file. */
function currentSpaFile(lock: unknown) {
  return applySpaToFile('# Third-Party Licenses\n', renderSpaSection(scanSpaPackages(ROOT, { io: spaIo(lock) })))
}

describe('spa-licenses — the real window, the list equals the fact (Test 8)', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'spa', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'spa', 'package-lock.json'), 'utf8')) as Lock
  const packages = scanSpaPackages(REPO_ROOT)
  const names = packages.map((p) => p.name)
  const listed = new Set(names)

  it('names every package the bundle carries, and nothing else', () => {
    // Declared: each `dependencies` entry of spa/package.json is on the list.
    for (const dep of Object.keys(manifest.dependencies ?? {})) expect(listed).toContain(dep)

    // Reachable: a transitive rides in the bundle exactly as hard as a direct
    // dependency, so every dependency OF a listed package is listed too.
    for (const p of packages.filter((x) => x.ships === 'bundled code')) {
      const entry = lock.packages[`node_modules/${p.name}`]
      expect(entry, `${p.name} is listed but absent from the lockfile`).toBeDefined()
      for (const dep of Object.keys(entry.dependencies ?? {})) expect(listed).toContain(dep)
    }

    // No extras: every listed name is either declared at the root, pulled in by
    // something else on the list, or a declared build-time emitter. Nothing rides
    // on the ledger that does not ride in the bundle.
    const reachable = new Set(Object.keys(manifest.dependencies ?? {}))
    for (const p of packages) {
      for (const dep of Object.keys(lock.packages[`node_modules/${p.name}`]?.dependencies ?? {})) reachable.add(dep)
    }
    for (const p of packages) {
      expect(reachable.has(p.name) || SPA_EMITTED_BY_BUILD.includes(p.name), `${p.name} is on the list but nothing pulls it in`).toBe(true)
    }

    // The build toolchain leaves nothing of its own behind and is absent — except
    // the emitters, which are on the list on purpose (Tailwind's CSS is Tailwind's).
    for (const dev of Object.keys(manifest.devDependencies ?? {})) {
      if (SPA_EMITTED_BY_BUILD.includes(dev)) expect(listed).toContain(dev)
      else expect(listed).not.toContain(dev)
    }

    expect(names).toEqual([...names].sort()) // deterministic order, no duplicates
    expect(new Set(names).size).toBe(names.length)
  })

  it('names react, react-dom, @tanstack/react-query and tailwind with their licences', () => {
    for (const required of ['react', 'react-dom', '@tanstack/react-query', 'tailwindcss']) {
      const row = packages.find((p) => p.name === required)
      expect(row, `${required} is missing from the window ledger`).toBeDefined()
      expect(row!.license).toBe('MIT')
      expect(row!.version).toMatch(/^\d+\.\d+/)
    }
    // The committed file names them too — the ledger is a document, not just a scan.
    const section = readSpaSection(readFileSync(join(REPO_ROOT, LICENSES_FILE), 'utf8')) ?? ''
    for (const required of ['react', 'react-dom', '@tanstack/react-query', 'tailwindcss']) {
      expect(section).toContain(`| ${required} | `)
    }
  })

  it('the committed window section matches a fresh render byte for byte, with zero violations', () => {
    const committed = readSpaSection(readFileSync(join(REPO_ROOT, LICENSES_FILE), 'utf8'))
    expect(committed).toBe(renderSpaSection(packages))

    const res = checkSpaLicenses({ pkgRoot: REPO_ROOT })
    expect(res.applicable).toBe(true)
    expect(res.violations).toEqual([])
    expect(res.packages.every((p) => isAllowedLicense(p.license))).toBe(true)
  })
})

describe('spa-licenses — the closure rule (Test 9)', () => {
  const lock: Lock = {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { alpha: '1.0.0', delta: '1.0.0' },
        devDependencies: { toolchain: '9.0.0', tailwindcss: '4.3.3' },
      },
      'node_modules/alpha': { version: '1.0.0', license: 'MIT', dependencies: { beta: '^2', gamma: '^3' } },
      'node_modules/beta': { version: '2.0.0', license: 'ISC' },
      'node_modules/gamma': { version: '3.0.0', license: 'MIT' }, // hoisted — NOT what alpha resolves
      'node_modules/alpha/node_modules/gamma': { version: '3.9.9', license: 'MIT' },
      'node_modules/delta': { version: '1.0.0', license: 'MIT', dev: true },
      'node_modules/toolchain': { version: '9.0.0', license: 'MIT', dev: true },
      'node_modules/tailwindcss': { version: '4.3.3', license: 'MIT', dev: true },
    },
  }

  it('follows transitives, resolves the NEAREST copy, skips dev, and never walks devDependencies', () => {
    const packages = scanSpaPackages(ROOT, { io: spaIo(lock) })
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      'alpha@1.0.0',
      'beta@2.0.0',
      'gamma@3.9.9', // the nested copy alpha actually requires, not the hoisted 3.0.0
      'tailwindcss@4.3.3',
    ])
    expect(packages.find((p) => p.name === 'tailwindcss')!.ships).toBe('emitted CSS')
    expect(packages.find((p) => p.name === 'alpha')!.ships).toBe('bundled code')
  })

  it('renders one row per package with the licence the lockfile states', () => {
    const rows = renderSpaSection(scanSpaPackages(ROOT, { io: spaIo(lock) }))
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Package'))
    expect(rows).toEqual([
      '| alpha | 1.0.0 | MIT | bundled code |',
      '| beta | 2.0.0 | ISC | bundled code |',
      '| gamma | 3.9.9 | MIT | bundled code |',
      '| tailwindcss | 4.3.3 | MIT | emitted CSS |',
    ])
  })

  it('reports nothing rather than a guess when the lockfile is absent or unparseable', () => {
    expect(scanSpaPackages(ROOT, { io: spaIo(lock, undefined, { lockfile: false }) })).toEqual([])
    expect(scanSpaPackages(ROOT, { io: spaIo('{ not json', undefined) })).toEqual([])
  })

  it('names a declared emitter the lockfile cannot resolve rather than dropping it', () => {
    // SPA_EMITTED_BY_BUILD is a claim about the build; an unresolvable name reads
    // as UNKNOWN, which the allowlist refuses out loud instead of omitting quietly.
    const orphan: Lock = { lockfileVersion: 3, packages: { '': { dependencies: {} } } }
    const packages = scanSpaPackages(ROOT, { io: spaIo(orphan) })
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(SPA_EMITTED_BY_BUILD.map((n) => `${n}@UNKNOWN`))
    expect(packages.every((p) => p.license === 'UNKNOWN')).toBe(true)
    expect(codes(checkSpaLicenses({ pkgRoot: ROOT, io: spaIo(orphan, currentSpaFile(orphan)) }))).toEqual(
      SPA_EMITTED_BY_BUILD.map(() => 'spa-license-forbidden'),
    )
  })
})

describe('spa-licenses — the gate (Test 10)', () => {
  const lock: Lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { alpha: '1.0.0' } },
      'node_modules/alpha': { version: '1.0.0', license: 'MIT' },
      'node_modules/tailwindcss': { version: '4.3.3', license: 'MIT' },
    },
  }

  it('is quiet when the committed section describes the lockfile', () => {
    expect(checkSpaLicenses({ pkgRoot: ROOT, io: spaIo(lock, currentSpaFile(lock)) }).violations).toEqual([])
  })

  it('flags ONE drifted byte, and a package on the lockfile missing from the table', () => {
    const drifted = currentSpaFile(lock).replace('1.0.0', '1.0.1')
    expect(codes(checkSpaLicenses({ pkgRoot: ROOT, io: spaIo(lock, drifted) }))).toEqual(['spa-licenses-stale'])

    const short: Lock = { lockfileVersion: 3, packages: { ...lock.packages, '': { dependencies: {} } } }
    expect(codes(checkSpaLicenses({ pkgRoot: ROOT, io: spaIo(lock, currentSpaFile(short)) }))).toEqual(['spa-licenses-stale'])
  })

  it('flags a licenses file with no window section at all', () => {
    expect(codes(checkSpaLicenses({ pkgRoot: ROOT, io: spaIo(lock, '# Third-Party Licenses\n') }))).toEqual(['spa-licenses-stale'])
  })

  it('flags a bundled package whose licence is outside the allowlist', () => {
    const copyleft: Lock = {
      lockfileVersion: 3,
      packages: { ...lock.packages, 'node_modules/alpha': { version: '1.0.0', license: 'GPL-3.0' } },
    }
    const res = checkSpaLicenses({ pkgRoot: ROOT, io: spaIo(copyleft, currentSpaFile(copyleft)) })
    expect(codes(res)).toEqual(['spa-license-forbidden'])
    expect(res.violations[0].detail).toContain('alpha@1.0.0')
    expect(res.violations[0].detail).toContain(LICENSE_ALLOWLIST[0])
  })

  it('a window source with no lockfile is a violation, never an empty ledger', () => {
    const res = checkSpaLicenses({ pkgRoot: ROOT, io: spaIo(lock, currentSpaFile(lock), { lockfile: false }) })
    expect(res.applicable).toBe(true)
    expect(codes(res)).toEqual(['spa-licenses-stale'])
    expect(res.violations[0].detail).toContain('cannot be read')
  })

  it('honest sentinel: a tree with no window source is not applicable', () => {
    const res = checkSpaLicenses({ pkgRoot: ROOT, io: spaIo(lock, undefined, { manifest: false, lockfile: false }) })
    expect(res.applicable).toBe(false)
    expect(res.violations).toEqual([])
    expect(res.packages).toEqual([])
  })

  it('the window splice is idempotent and leaves the daemon section alone', () => {
    const withDaemon = applyToFile('# Third-Party Licenses\n', renderSection([{ name: 'pg', version: '8.0.0', license: 'MIT' }]))
    const rendered = renderSpaSection(scanSpaPackages(ROOT, { io: spaIo(lock) }))
    const once = applySpaToFile(withDaemon, rendered)
    expect(applySpaToFile(once, rendered)).toBe(once)
    expect(readSection(once)).toBe(readSection(withDaemon))
    expect(readSpaSection(once)).toBe(rendered)
  })
})

describe('spa-licenses — the notices claim is measured (Test 11)', () => {
  const assetsDir = join(REPO_ROOT, 'daemon', 'static', 'app', 'assets')
  const built = existsSync(assetsDir)
  const section = readSpaSection(readFileSync(join(REPO_ROOT, LICENSES_FILE), 'utf8')) ?? ''

  it('the ledger states the finding in words, both halves of it', () => {
    expect(section).toContain('Copyright notices in the built bundle')
    expect(section).toContain('The JavaScript does **not**')
    expect(section).toContain('tailwindcss v')
  })

  it.skipIf(!built)('a real build keeps the CSS notice and keeps no copyright line in the JS', () => {
    const assets = readdirSync(assetsDir).map(String)
    const js = assets.filter((f) => f.endsWith('.js'))
    const css = assets.filter((f) => f.endsWith('.css'))
    expect(js.length, 'a built window with no JS asset is not a built window').toBeGreaterThan(0)
    expect(css.length).toBeGreaterThan(0)

    // The JS half: minification drops every banner. Recorded, not wished away.
    for (const file of js) {
      const text = readFileSync(join(assetsDir, file), 'utf8')
      expect(text, `${file} unexpectedly carries a copyright line — the ledger says it does not`).not.toMatch(/copyright/i)
      expect(text).not.toContain('@license')
    }

    // The CSS half: `/*! … */` survives, and the version in that notice is the
    // version the ledger names. A Tailwind bump that leaves the prose behind is
    // a red test, not a quiet lie.
    const cssText = css.map((f) => readFileSync(join(assetsDir, f), 'utf8')).join('\n')
    const notice = cssText.match(/\/\*!\s*tailwindcss v([\d.]+)\s*\|\s*MIT License/)
    expect(notice, 'the built CSS carries no Tailwind legal comment — the ledger says it does').not.toBeNull()
    const row = section.split('\n').find((l) => l.startsWith('| tailwindcss | '))
    expect(row).toContain(`| ${notice![1]} |`)
    expect(section).toContain(`tailwindcss v${notice![1]} | MIT License`)
  })
})
