/**
 * package-check.mjs — the npm publishability gate (BL-163/BL-164, v3.6).
 *
 * `npx -y sma-framework@latest init` is the front door; a tarball that ships
 * `private:true`, a stale version, or a missing bin file kills the adopter's
 * first five minutes. This check makes "publishable" a NUMBER instead of a
 * feeling — and pins the BL-164 single-source law: the release tag, the
 * package.json version, the capability.json version, and the installer banner
 * must all be ONE value (the banner already reads package.json, so the check
 * here is package.json == capability.json).
 *
 * Violations counted (--count prints the bare total, D-49.3-16 scorer contract):
 *   1. package.json carries a truthy `private` flag
 *   2. package.json version != sma-core/capabilities/sma/capability.json version
 *   3. a `bin` entry whose target file is missing
 *   4. a `files[]` entry missing on disk
 *   5. missing `repository`/`license` metadata (the npm page is the shop window)
 *
 * Honest sentinel: run in a tree that is NOT the product package (no
 * capability.json next to the runtime — e.g. the platform mirror of scripts/sma),
 * the check prints `-1` (not applicable), never a fake 0.
 *
 * Self-runnable (safe-command allowlisted): `node scripts/sma/lib/package-check.mjs
 * --count`; `--strict` exits 1 on any violation (the prepublishOnly gate).
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * checkPackage({pkgRoot, io}) — pure given an io; returns
 * {applicable:boolean, violations:Array<{code,detail}>}.
 */
export function checkPackage({ pkgRoot, io } = {}) {
  const read = io ?? { exists: existsSync, readFile: (p) => readFileSync(p, 'utf8') }
  const violations = []

  const pkgPath = join(pkgRoot, 'package.json')
  const capPath = join(pkgRoot, 'sma-core', 'capabilities', 'sma', 'capability.json')
  if (!read.exists(pkgPath) || !read.exists(capPath)) return { applicable: false, violations: [] }

  let pkg
  let cap
  try {
    pkg = JSON.parse(read.readFile(pkgPath))
    cap = JSON.parse(read.readFile(capPath))
  } catch (err) {
    return { applicable: true, violations: [{ code: 'unparseable', detail: String(err && err.message ? err.message : err) }] }
  }

  if (pkg.private) violations.push({ code: 'private-flag', detail: 'package.json carries "private": true — npm publish refuses it' })
  if (String(pkg.version) !== String(cap.version)) {
    violations.push({ code: 'version-split', detail: `package.json ${pkg.version} != capability.json ${cap.version} (BL-164 single-source law)` })
  }
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    if (!read.exists(join(pkgRoot, target))) violations.push({ code: 'bin-missing', detail: `bin "${name}" -> ${target} not on disk` })
  }
  for (const entry of pkg.files ?? []) {
    if (!read.exists(join(pkgRoot, entry))) violations.push({ code: 'files-missing', detail: `files[] entry "${entry}" not on disk` })
  }
  if (!pkg.repository) violations.push({ code: 'no-repository', detail: 'package.json has no repository field' })
  if (!pkg.license) violations.push({ code: 'no-license', detail: 'package.json has no license field' })

  return { applicable: true, violations }
}

// ── direct run (`node scripts/sma/lib/package-check.mjs [--count|--json|--strict]`) ──
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const { applicable, violations } = checkPackage({ pkgRoot })
  const flags = new Set(process.argv.slice(2))
  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify({ applicable, pkgRoot, violations }) + '\n')
  } else if (!flags.has('--count')) {
    if (!applicable) process.stdout.write('package-check: not a product package root (no capability.json) — not applicable\n')
    for (const v of violations) process.stdout.write(`  [${v.code}] ${v.detail}\n`)
  }
  const count = applicable ? violations.length : -1
  process.stdout.write(`${count}\n`) // bare last line — the P-BL-163 scorer contract
  process.exit(flags.has('--strict') && count !== 0 ? 1 : 0)
}
