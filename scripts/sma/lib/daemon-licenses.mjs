/**
 * daemon-licenses.mjs — the shipped-dependency license ledger, GENERATED from disk.
 *
 * The package hands the adopter other people's code through TWO doors, and both
 * of them used to be one person's memory away from going stale:
 *
 *   1. The daemon ships with its dependency tree already inside the package
 *      (`daemon/node_modules`), so an adopter never runs a second `npm install`
 *      to bring the V5 layer up.
 *   2. The operator's window ships already BUILT (`daemon/static/app`), so react,
 *      react-dom, @tanstack/react-query and Tailwind's CSS ride to the adopter
 *      compiled into two files — no less shipped for being minified.
 *
 * That convenience moves a legal obligation onto us: those are other people's
 * packages, and the package documentation already PROMISES that «its licences
 * are tracked in THIRD-PARTY-LICENSES.md». A promise kept by hand is a promise
 * that rots at the next `npm update`, so neither list is written by hand at all:
 *
 *   read what actually ships  ->  render a deterministic table  ->  splice it
 *   into THIRD-PARTY-LICENSES.md between two markers
 *
 * and the publishability gate (package-check.mjs) re-renders from disk and
 * refuses a tarball whose committed section differs by a single byte, or whose
 * shipped code carries a license outside LICENSE_ALLOWLIST. A stale ledger is
 * therefore a NUMBER, not a feeling — the same posture the test badge already
 * has.
 *
 * The two halves read different sources, and deliberately. The vendored daemon
 * tree IS on disk in the package, so it is scanned. The window's tree is NOT —
 * `daemon/static/app` is a gitignored build artefact and `spa/node_modules` never
 * ships — so its half reads the COMMITTED `spa/package-lock.json`, which is
 * present in every clone and in the tarball's source of truth. A gate that only
 * works where someone happened to run `npm install` is not a gate.
 *
 * Pure functions + an injected io throughout (the house DI convention), so the
 * tests read fixtures instead of the real tree. The managed-block splice is
 * consumed from passport.mjs rather than re-implemented.
 *
 * Self-runnable (no shebang — this file is imported by tests):
 *   node scripts/sma/lib/daemon-licenses.mjs            # report drift, bare count last
 *   node scripts/sma/lib/daemon-licenses.mjs --print    # both rendered sections
 *   node scripts/sma/lib/daemon-licenses.mjs --write    # regenerate both sections
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readManagedBlock, spliceManagedBlock } from './passport.mjs'

/** The vendored tree, relative to the package root. */
export const VENDORED_DIR = join('daemon', 'node_modules')
/** The file both sections live in. */
export const LICENSES_FILE = 'THIRD-PARTY-LICENSES.md'
/** The managed-block markers. Everything between them is generated. */
export const SECTION_BEGIN = '<!-- daemon-vendored:begin -->'
export const SECTION_END = '<!-- daemon-vendored:end -->'

/** The window's manifest — its presence is what makes the window half applicable. */
export const SPA_MANIFEST = join('spa', 'package.json')
/** The window's lockfile — the COMMITTED source of the versions and licences. */
export const SPA_LOCKFILE = join('spa', 'package-lock.json')
/** The window section's managed-block markers. */
export const SPA_SECTION_BEGIN = '<!-- spa-bundle:begin -->'
export const SPA_SECTION_END = '<!-- spa-bundle:end -->'

/**
 * Build-time packages whose OWN AUTHORED OUTPUT rides in the bundle.
 *
 * `dependencies` and `devDependencies` is the wrong line to draw for a bundler.
 * Vite, TypeScript and the `@types/*` packages are devDependencies that leave
 * nothing of themselves behind — they read our source and emit our source. But
 * Tailwind is a devDependency whose preflight and utility CSS is Tailwind's own
 * authoring, and it lands verbatim in `assets/index-*.css`. Shipping somebody's
 * CSS is shipping their work, whichever dependency block installed the tool that
 * emitted it, so it is listed.
 *
 * A name here that the lockfile does not resolve renders as UNKNOWN and is
 * therefore a loud violation, never a silent omission: the list is a claim about
 * what this build emits, and a claim nobody maintains is worse than no claim.
 */
export const SPA_EMITTED_BY_BUILD = Object.freeze(['tailwindcss'])

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

// ── the window bundle half ────────────────────────────────────────────────────

/** The one prose line above the window table — generated with it, never apart. */
const SPA_SECTION_PROSE =
  'The operator\'s window is built from `spa/` into `daemon/static/app` and ships inside the package already compiled, so these packages reach the adopter as bundle bytes rather than as files of their own. The list is the runtime closure of `spa/package.json`\'s `dependencies` — every package whose code the bundler can reach — plus the build-time packages whose own authored output lands in the bundle. Versions and licences are read from the committed `spa/package-lock.json`, which is present in every clone; build-only tooling that leaves nothing of itself behind (vite, typescript, the `@types/*` packages) is deliberately absent.'

/**
 * The measured answer to «does minification keep the notices?» — recorded as words
 * because the bundle it describes is a gitignored artefact the ledger cannot read.
 * A test re-measures it against a real build whenever one is present.
 */
const SPA_NOTICES_PROSE = [
  '**Copyright notices in the built bundle — measured, not assumed.** The CSS keeps its notice: `/*!`-style legal comments survive minification, so `assets/index-*.css` still carries `/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */`. The JavaScript does **not**: minification strips every `@license` banner, and `assets/index-*.js` ends up with no copyright line in it at all — React\'s `/** @license React */` headers included.',
  '',
  'MIT asks for the copyright and permission notice in every copy or substantial portion, so the notices travel WITH the bundle in this file instead of inside it — see «Window bundle — MIT notices (verbatim)» above. This file is packed by `files[]`, so it reaches the adopter in the same tarball as the bundle it describes. That is a statement about a real build, not a belief about the toolchain: the test suite re-measures both halves of it against `daemon/static/app` whenever a build is on disk.',
].join('\n')

/** The heading the generated window block owns. */
const SPA_SECTION_HEADING = '## Window bundle dependencies (generated)'

/**
 * resolveLockKey(packages, fromKey, depName) -> the lockfile key npm would resolve
 * `depName` to when required from `fromKey`, or null.
 *
 * npm's own rule, no more: look in the nearest `node_modules` and walk up. Doing
 * it properly matters because a nested duplicate is a DIFFERENT version, and a
 * ledger that reports the hoisted one would name a package the bundle does not
 * carry. Lockfile keys are always `/`-joined, so this is string work, not paths.
 */
function resolveLockKey(packages, fromKey, depName) {
  let base = String(fromKey ?? '')
  for (;;) {
    const candidate = base ? `${base}/node_modules/${depName}` : `node_modules/${depName}`
    if (packages[candidate]) return candidate
    if (!base) return null
    const cut = base.lastIndexOf('/node_modules/')
    base = cut === -1 ? '' : base.slice(0, cut)
  }
}

/**
 * scanSpaPackages(rootDir, {io}) -> [{name, version, license, ships}] sorted by
 * name then version, deduped by `name@version`.
 *
 * Reads `spa/package-lock.json` and walks the `dependencies` graph from the root
 * entry — transitives included, because a transitive is bundled exactly as hard as
 * a direct one (`scheduler` is nobody's declared dependency and is in every byte of
 * React DOM the adopter runs). `devDependencies` are not walked: that is the build
 * toolchain, and it does not ride along. An entry the lockfile marks `dev` is
 * skipped even if the graph reaches it — a dev-only resolution is not in the bundle.
 *
 * A missing or unparseable lockfile reports nothing rather than a guess; the caller
 * decides whether that is a verdict (checkSpaLicenses) or a non-question.
 */
export function scanSpaPackages(rootDir, { io } = {}) {
  const read = io ?? defaultIo()
  const lockPath = join(rootDir, SPA_LOCKFILE)
  if (!read.exists(lockPath)) return []
  let lock
  try {
    lock = JSON.parse(read.readFile(lockPath))
  } catch {
    return []
  }
  const entries = (lock && lock.packages) || {}
  const found = new Map()
  const visited = new Set()

  const visit = (fromKey, depName) => {
    const key = resolveLockKey(entries, fromKey, depName)
    if (!key || visited.has(key)) return
    visited.add(key)
    const entry = entries[key] || {}
    if (entry.dev === true) return // installed for the build only — never in the bundle
    const version = String(entry.version ?? 'UNKNOWN')
    found.set(`${depName}@${version}`, { name: depName, version, license: licenseOf(entry), ships: 'bundled code' })
    for (const next of Object.keys(entry.dependencies ?? {}).sort(cmp)) visit(key, next)
  }

  const root = entries[''] || {}
  for (const dep of Object.keys(root.dependencies ?? {}).sort(cmp)) visit('', dep)

  // The build-time emitters, appended last so a package that is BOTH (a runtime
  // dependency that also emits) keeps its truer «bundled code» row.
  for (const name of SPA_EMITTED_BY_BUILD) {
    if ([...found.values()].some((p) => p.name === name)) continue
    const key = resolveLockKey(entries, '', name)
    const entry = key ? entries[key] : null
    const version = String((entry && entry.version) ?? 'UNKNOWN')
    found.set(`${name}@${version}`, {
      name,
      version,
      license: entry ? licenseOf(entry) : 'UNKNOWN',
      ships: 'emitted CSS',
    })
  }

  return [...found.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version))
}

/**
 * renderSpaSection(packages) -> the generated window block's INNER text (no markers).
 * Byte-deterministic, same as the daemon one; the extra column exists because the
 * two ways a package reaches the adopter are not the same claim.
 */
export function renderSpaSection(packages) {
  const rows = [...(packages ?? [])].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version))
  const lines = [
    SPA_SECTION_HEADING,
    '',
    SPA_SECTION_PROSE,
    '',
    '| Package | Version | License | Ships as |',
    '|---|---|---|---|',
  ]
  for (const p of rows) lines.push(`| ${p.name} | ${p.version} | ${p.license} | ${p.ships ?? 'bundled code'} |`)
  lines.push('', SPA_NOTICES_PROSE)
  return lines.join('\n')
}

/** applySpaToFile(content, rendered) -> the file text with the window block replaced. */
export function applySpaToFile(content, rendered) {
  return spliceManagedBlock(content, rendered, SPA_SECTION_BEGIN, SPA_SECTION_END)
}

/** readSpaSection(content) -> the committed window block's inner text, or null. */
export function readSpaSection(content) {
  return readManagedBlock(String(content ?? '').replace(/\r\n/g, '\n'), SPA_SECTION_BEGIN, SPA_SECTION_END)
}

/**
 * checkSpaLicenses({pkgRoot, io}) -> {applicable, packages, violations}.
 *
 * The same two mechanical classes as the daemon half, under their own codes:
 *   - `spa-licenses-stale`    — the committed window section is not what the
 *     lockfile renders to (or is missing): the ledger no longer describes the
 *     bundle the tarball carries.
 *   - `spa-license-forbidden` — a bundled package's license is outside
 *     LICENSE_ALLOWLIST, including an unstated one.
 *
 * Narrow sentinel, matching package-check's bundle rule: the question is only
 * asked where the window's SOURCE lives. An installed copy or a consumer mirror
 * of `scripts/sma` has no `spa/`, and inventing a verdict there would be noise.
 */
export function checkSpaLicenses({ pkgRoot, io } = {}) {
  const read = io ?? defaultIo()
  const violations = []
  if (!read.exists(join(pkgRoot, SPA_MANIFEST))) return { applicable: false, packages: [], violations }
  if (!read.exists(join(pkgRoot, SPA_LOCKFILE))) {
    violations.push({
      code: 'spa-licenses-stale',
      detail: `${SPA_MANIFEST} exists but ${SPA_LOCKFILE} does not — the window's licences cannot be read, and an unreadable ledger is not an empty one`,
    })
    return { applicable: true, packages: [], violations }
  }

  const packages = scanSpaPackages(pkgRoot, { io: read })
  for (const p of packages) {
    if (!isAllowedLicense(p.license)) {
      violations.push({
        code: 'spa-license-forbidden',
        detail: `the window bundle carries ${p.name}@${p.version}, licensed "${p.license}" — outside the allowlist (${LICENSE_ALLOWLIST.join(', ')}); a human decides before it ships`,
      })
    }
  }

  const rendered = renderSpaSection(packages)
  const licensesPath = join(pkgRoot, LICENSES_FILE)
  const committed = read.exists(licensesPath) ? readSpaSection(read.readFile(licensesPath)) : null
  if (committed === null) {
    violations.push({
      code: 'spa-licenses-stale',
      detail: `${LICENSES_FILE} carries no generated window section but the bundle ships ${packages.length} package(s) — regenerate it (node scripts/sma/lib/daemon-licenses.mjs --write)`,
    })
  } else if (committed !== rendered) {
    violations.push({
      code: 'spa-licenses-stale',
      detail: `${LICENSES_FILE}'s window section does not match the ${packages.length} package(s) the bundle ships — regenerate it (node scripts/sma/lib/daemon-licenses.mjs --write)`,
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
  const spaApplicable = existsSync(join(pkgRoot, SPA_MANIFEST))
  const spaPackages = spaApplicable ? scanSpaPackages(pkgRoot) : []
  const spaRendered = renderSpaSection(spaPackages)

  if (flags.has('--print')) {
    process.stdout.write(rendered + '\n')
    if (spaApplicable) process.stdout.write('\n' + spaRendered + '\n')
    process.exit(0)
  }

  if (flags.has('--write')) {
    const licensesPath = join(pkgRoot, LICENSES_FILE)
    const before = existsSync(licensesPath) ? readFileSync(licensesPath, 'utf8') : ''
    const withDaemon = applyToFile(before, rendered)
    const after = spaApplicable ? applySpaToFile(withDaemon, spaRendered) : withDaemon
    if (after !== before) writeFileSync(licensesPath, after)
    const what = `${packages.length} vendored package(s)${spaApplicable ? ` + ${spaPackages.length} bundled package(s)` : ''}`
    process.stdout.write(`${LICENSES_FILE}: ${what}${after === before ? ' (already current)' : ' written'}\n`)
    process.exit(0)
  }

  const daemonResult = checkDaemonLicenses({ pkgRoot })
  const spaResult = checkSpaLicenses({ pkgRoot })
  const applicable = daemonResult.applicable || spaResult.applicable
  const violations = [...daemonResult.violations, ...spaResult.violations]
  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify({ applicable, pkgRoot, packages, spaPackages, violations }) + '\n')
  } else if (!flags.has('--count')) {
    if (!applicable) process.stdout.write('daemon-licenses: no vendored daemon tree and no window source here — not applicable\n')
    for (const v of violations) process.stdout.write(`  [${v.code}] ${v.detail}\n`)
  }
  process.stdout.write(`${applicable ? violations.length : -1}\n`) // bare last line — the scorer contract
  process.exit(violations.length === 0 ? 0 : 1)
}
