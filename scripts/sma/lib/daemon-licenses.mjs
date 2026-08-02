/**
 * daemon-licenses.mjs — the vendored-daemon license ledger, GENERATED from disk.
 *
 * The daemon ships with its dependency tree already inside the package
 * (`daemon/node_modules`), so an adopter never runs a second `npm install` to
 * bring the V5 layer up. That convenience moves a legal obligation onto us:
 * those are other people's packages, and the package documentation already
 * PROMISES that «its licences are tracked in THIRD-PARTY-LICENSES.md». A
 * promise kept by hand is a promise that rots at the next `npm update`, so the
 * list is not written by hand at all:
 *
 *   scan the vendored tree  ->  render a deterministic table  ->  splice it
 *   into THIRD-PARTY-LICENSES.md between two markers
 *
 * and the publishability gate (package-check.mjs) re-renders from disk and
 * refuses a tarball whose committed section differs by a single byte, or whose
 * vendored tree carries a license outside LICENSE_ALLOWLIST. A stale ledger is
 * therefore a NUMBER, not a feeling — the same posture the test badge already
 * has.
 *
 * Pure functions + an injected io throughout (the house DI convention), so the
 * tests read fixtures instead of the real tree. The managed-block splice is
 * consumed from passport.mjs rather than re-implemented.
 *
 * Self-runnable (no shebang — this file is imported by tests):
 *   node scripts/sma/lib/daemon-licenses.mjs            # report drift, bare count last
 *   node scripts/sma/lib/daemon-licenses.mjs --print    # the rendered section
 *   node scripts/sma/lib/daemon-licenses.mjs --write    # regenerate the section
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readManagedBlock, spliceManagedBlock } from './passport.mjs'

/** The vendored tree, relative to the package root. */
export const VENDORED_DIR = join('daemon', 'node_modules')
/** The file the section lives in. */
export const LICENSES_FILE = 'THIRD-PARTY-LICENSES.md'
/** The managed-block markers. Everything between them is generated. */
export const SECTION_BEGIN = '<!-- daemon-vendored:begin -->'
export const SECTION_END = '<!-- daemon-vendored:end -->'

/**
 * The licenses we are willing to vendor into the tarball. Permissive, notice-only
 * terms — every one of them is satisfied by shipping the upstream LICENSE file,
 * which is exactly what vendoring does. Anything else (copyleft, source-available,
 * unstated) is a decision a human must make BEFORE it rides in a published
 * package, so the gate stops it rather than discovering it after release.
 */
export const LICENSE_ALLOWLIST = Object.freeze([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
])

/** The one prose line above the table — generated with it, so it cannot drift apart. */
const SECTION_PROSE =
  'These packages are vendored (shipped inside the package) so the optional daemon needs no second install; each one keeps its own LICENSE file inside `daemon/node_modules`.'

/** The heading the generated block owns. */
const SECTION_HEADING = '## Daemon vendored dependencies (generated)'

/** Default io: real disk. Injected everywhere so tests never touch the tree. */
function defaultIo() {
  return {
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    readdir: (p) => readdirSync(p),
  }
}

/** Stable, locale-independent string order (passport.mjs's sort convention). */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * licenseOf(pkgJson) -> the SPDX expression as a string.
 * npm has carried three shapes over the years: `license: "MIT"`, the deprecated
 * `license: {type}` object, and the older `licenses: [{type}]` array. A package
 * that states nothing reads as `UNKNOWN` — never as an assumed permissive value.
 */
export function licenseOf(pkgJson) {
  const l = pkgJson && pkgJson.license
  if (typeof l === 'string' && l.trim()) return l.trim()
  if (l && typeof l === 'object' && typeof l.type === 'string' && l.type.trim()) return l.type.trim()
  const arr = pkgJson && pkgJson.licenses
  if (Array.isArray(arr) && arr.length > 0) {
    const types = arr.map((e) => (typeof e === 'string' ? e : e && e.type)).filter(Boolean)
    if (types.length > 0) return types.join(' OR ')
  }
  return 'UNKNOWN'
}

/**
 * isAllowedLicense(expression) -> boolean.
 * Reads the SPDX expression the way the license itself reads: an OR is a choice,
 * so ONE allowlisted operand is enough (`(MIT OR CC0-1.0)` ships under MIT); an
 * AND binds us to every operand, so all of them must be allowlisted. Anything
 * unparsed or unstated is not allowed — the honest default when the answer is
 * «we do not know» is «a human decides».
 */
export function isAllowedLicense(expression) {
  const text = String(expression ?? '').trim()
  if (!text) return false
  const allowed = new Set(LICENSE_ALLOWLIST.map((l) => l.toLowerCase()))
  const strip = (s) => s.trim().replace(/^\(+/, '').replace(/\)+$/, '').trim()
  const isTerm = (s) => allowed.has(strip(s).toLowerCase())
  // OR binds loosest: split on it first, then require every AND-operand of the
  // chosen branch. `+` suffixes (`Apache-2.0+`) are deliberately NOT normalized
  // away — a different id is a different license until someone says otherwise.
  return text
    .split(/\s+OR\s+/i)
    .some((branch) => branch.split(/\s+AND\s+/i).every((term) => isTerm(term)))
}

/**
 * scanDaemonPackages(rootDir, {io}) -> [{name, version, license, dir}] sorted by
 * name then version, deduped by `name@version`.
 *
 * Walks `daemon/node_modules`, including scoped `@scope/pkg` directories and any
 * NESTED `node_modules` a transitive conflict may have produced — a nested copy
 * is a shipped package too, and a scanner that only reads the top level would
 * under-report exactly the packages nobody remembers installing. An entry
 * without a readable package.json is skipped silently: it is not a package.
 */
export function scanDaemonPackages(rootDir, { io } = {}) {
  const read = io ?? defaultIo()
  const root = join(rootDir, VENDORED_DIR)
  const found = new Map()

  const visitDir = (modulesDir) => {
    if (!read.exists(modulesDir)) return
    let entries
    try {
      entries = read.readdir(modulesDir)
    } catch {
      return // an unreadable directory reports nothing, never a guess
    }
    for (const entry of [...entries].map(String).sort(cmp)) {
      if (entry.startsWith('.')) continue
      const dir = join(modulesDir, entry)
      if (entry.startsWith('@')) {
        // a scope directory holds packages, never a package itself
        let scoped
        try {
          scoped = read.readdir(dir)
        } catch {
          continue
        }
        for (const inner of [...scoped].map(String).sort(cmp)) {
          if (inner.startsWith('.')) continue
          visitPackage(join(dir, inner))
        }
        continue
      }
      visitPackage(dir)
    }
  }

  const visitPackage = (dir) => {
    const manifest = join(dir, 'package.json')
    if (read.exists(manifest)) {
      let pkg
      try {
        pkg = JSON.parse(read.readFile(manifest))
      } catch {
        pkg = null
      }
      if (pkg && typeof pkg.name === 'string' && pkg.name) {
        const version = String(pkg.version ?? 'UNKNOWN')
        const key = `${pkg.name}@${version}`
        if (!found.has(key)) found.set(key, { name: pkg.name, version, license: licenseOf(pkg), dir })
      }
    }
    visitDir(join(dir, 'node_modules'))
  }

  visitDir(root)
  return [...found.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version))
}

/**
 * renderSection(packages) -> the generated block's INNER text (no markers).
 * Byte-deterministic: sorted rows, one table shape, a fixed prose line. Two runs
 * over the same tree produce the same bytes, which is what makes the drift check
 * a comparison instead of an opinion.
 */
export function renderSection(packages) {
  const rows = [...(packages ?? [])].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version))
  const lines = [SECTION_HEADING, '', SECTION_PROSE, '', '| Package | Version | License |', '|---|---|---|']
  for (const p of rows) lines.push(`| ${p.name} | ${p.version} | ${p.license} |`)
  return lines.join('\n')
}

/**
 * applyToFile(content, rendered) -> the file text with the block replaced (or,
 * when the markers are absent, appended at EOF). Idempotent by construction —
 * the splice is passport.mjs's managed-block writer, not a second copy of it.
 */
export function applyToFile(content, rendered) {
  return spliceManagedBlock(content, rendered, SECTION_BEGIN, SECTION_END)
}

/** readSection(content) -> the committed block's inner text, or null when absent. */
export function readSection(content) {
  return readManagedBlock(String(content ?? '').replace(/\r\n/g, '\n'), SECTION_BEGIN, SECTION_END)
}

/**
 * checkDaemonLicenses({pkgRoot, io}) -> {applicable, packages, violations}.
 *
 * Two violation classes, both mechanical:
 *   - `daemon-licenses-stale`  — the section re-rendered from disk differs from
 *     the committed one (or is missing entirely): the ledger no longer describes
 *     what the tarball carries.
 *   - `daemon-license-forbidden` — a vendored package's license is outside
 *     LICENSE_ALLOWLIST (including an unstated one).
 *
 * Honest boundary: a tree with no vendored daemon tree is NOT applicable and
 * produces no verdict — a consumer mirror of `scripts/sma` has nothing to check,
 * and inventing a violation there would be noise.
 */
export function checkDaemonLicenses({ pkgRoot, io } = {}) {
  const read = io ?? defaultIo()
  const violations = []
  if (!read.exists(join(pkgRoot, VENDORED_DIR)) || typeof read.readdir !== 'function') {
    return { applicable: false, packages: [], violations }
  }

  const packages = scanDaemonPackages(pkgRoot, { io: read })
  for (const p of packages) {
    if (!isAllowedLicense(p.license)) {
      violations.push({
        code: 'daemon-license-forbidden',
        detail: `vendored ${p.name}@${p.version} is licensed "${p.license}" — outside the allowlist (${LICENSE_ALLOWLIST.join(', ')}); a human decides before it ships`,
      })
    }
  }

  const rendered = renderSection(packages)
  const licensesPath = join(pkgRoot, LICENSES_FILE)
  const committed = read.exists(licensesPath) ? readSection(read.readFile(licensesPath)) : null
  if (committed === null) {
    violations.push({
      code: 'daemon-licenses-stale',
      detail: `${LICENSES_FILE} carries no generated daemon section but ${packages.length} package(s) are vendored — regenerate it (node scripts/sma/lib/daemon-licenses.mjs --write)`,
    })
  } else if (committed !== rendered) {
    violations.push({
      code: 'daemon-licenses-stale',
      detail: `${LICENSES_FILE}'s daemon section does not match the ${packages.length} package(s) on disk — regenerate it (node scripts/sma/lib/daemon-licenses.mjs --write)`,
    })
  }

  return { applicable: true, packages, violations }
}

// ── direct run (`node scripts/sma/lib/daemon-licenses.mjs [--print|--write|--count|--json]`) ──
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const flags = new Set(process.argv.slice(2))
  const packages = scanDaemonPackages(pkgRoot)
  const rendered = renderSection(packages)

  if (flags.has('--print')) {
    process.stdout.write(rendered + '\n')
    process.exit(0)
  }

  if (flags.has('--write')) {
    const licensesPath = join(pkgRoot, LICENSES_FILE)
    const before = existsSync(licensesPath) ? readFileSync(licensesPath, 'utf8') : ''
    const after = applyToFile(before, rendered)
    if (after !== before) writeFileSync(licensesPath, after)
    process.stdout.write(`${LICENSES_FILE}: ${packages.length} vendored package(s)${after === before ? ' (already current)' : ' written'}\n`)
    process.exit(0)
  }

  const { applicable, violations } = checkDaemonLicenses({ pkgRoot })
  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify({ applicable, pkgRoot, packages, violations }) + '\n')
  } else if (!flags.has('--count')) {
    if (!applicable) process.stdout.write('daemon-licenses: no vendored daemon tree here — not applicable\n')
    for (const v of violations) process.stdout.write(`  [${v.code}] ${v.detail}\n`)
  }
  process.stdout.write(`${applicable ? violations.length : -1}\n`) // bare last line — the scorer contract
  process.exit(violations.length === 0 ? 0 : 1)
}
