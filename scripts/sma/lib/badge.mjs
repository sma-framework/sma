/**
 * badge.mjs — the README test badge, written from a MEASURED receipt.
 *
 * THE LAW: the number on the badge is never typed by hand. It is derived from a
 * suite run, stamped into `test-receipt.json`, and written into BOTH READMEs by
 * this module. `package-check --strict` (the prepublishOnly gate) then refuses a
 * release whose badge and receipt disagree, so a stale badge cannot ship — the
 * failure mode that let `tests-876/876` sit in the shop window while the real
 * suite had grown past it.
 *
 * Two ways in, one of them measured by construction:
 *   --from-vitest <file>   parse `vitest run --reporter=json --outputFile=<file>`
 *                          and take numTotalTests / numTotalTestSuites from it.
 *                          Refuses to stamp anything but a fully green run.
 *   --from-suite <t>/<f>   explicit numbers, for a runner whose JSON is already
 *                          summarised. Still routed through the receipt.
 *   --check                compare both READMEs against the receipt; exit 1 on a
 *                          mismatch. This is what the release gate calls.
 *
 * The receipt is the single source; the two READMEs are projections of it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the measured numbers live. Relative to the package root. */
export const RECEIPT_FILE = 'test-receipt.json'
/** The READMEs that carry a badge. Both are rewritten together — the README law. */
export const BADGE_READMES = ['README.md', 'README.ru.md']

/** Matches the shields.io test badge and its alt text, in either README. */
const BADGE_URL_RE = /(badge\/tests-)(\d+)(%2F)(\d+)(-)/g
const BADGE_ALT_RE = /(alt="(?:tests|тесты) )(\d+)(\/)(\d+)(")/g

/**
 * parseVitestJson(text) -> {tests, files} | throws.
 * Reads vitest's JSON reporter shape. A run with ANY failure is refused: a badge
 * that says "1512/1512" on a red suite is exactly the lie this module exists to
 * prevent.
 */
export function parseVitestJson(text) {
  const r = JSON.parse(text)
  const tests = Number(r.numTotalTests)
  // NOT numTotalTestSuites — that counts `describe` blocks (743 here), not files.
  // The file count is the length of the per-file results array.
  const files = Array.isArray(r.testResults) ? r.testResults.length : Number(r.numTotalTestSuites)
  if (!Number.isFinite(tests) || !Number.isFinite(files)) {
    throw new Error('vitest json carries no numTotalTests / test file results')
  }
  const failed = Number(r.numFailedTests ?? 0)
  const passed = Number(r.numPassedTests ?? tests)
  if (failed > 0 || passed !== tests) {
    throw new Error(`refusing to stamp a badge from a non-green run: ${passed}/${tests} passed, ${failed} failed`)
  }
  return { tests, files }
}

/** parseSuiteSpec("1318/91") -> {tests, files}. */
export function parseSuiteSpec(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec).trim())
  if (!m) throw new Error(`--from-suite expects <tests>/<files>, got "${spec}"`)
  return { tests: Number(m[1]), files: Number(m[2]) }
}

/**
 * applyBadge(readmeText, tests) -> {text, replaced}. Rewrites both the shields
 * URL and the alt text to `tests/tests` (a green suite is all of it).
 */
export function applyBadge(readmeText, tests) {
  let replaced = 0
  let text = readmeText.replace(BADGE_URL_RE, (_m, a, _o, sep, _o2, tail) => {
    replaced++
    return `${a}${tests}${sep}${tests}${tail}`
  })
  text = text.replace(BADGE_ALT_RE, (_m, a, _o, sep, _o2, tail) => {
    replaced++
    return `${a}${tests}${sep}${tests}${tail}`
  })
  return { text, replaced }
}

/** readBadge(readmeText) -> the number on the badge, or null if there is none. */
export function readBadge(readmeText) {
  const m = /badge\/tests-(\d+)%2F(\d+)-/.exec(readmeText)
  return m ? { shown: Number(m[1]), total: Number(m[2]) } : null
}

/** The receipt shape written to disk. */
export function buildReceipt({ tests, files }) {
  return { tests, files, measuredAt: new Date().toISOString(), source: 'vitest' }
}

/**
 * checkBadge({pkgRoot, io}) -> {ok, violations}. Pure given an io. The receipt is
 * authoritative; a README that disagrees with it is stale.
 */
export function checkBadge({ pkgRoot, io } = {}) {
  const read = io ?? { exists: existsSync, readFile: (p) => readFileSync(p, 'utf8') }
  const violations = []

  // The law binds only a project that MAKES the claim. No badge anywhere -> there
  // is no public number to keep honest, and demanding a receipt would be noise.
  const badged = []
  for (const name of BADGE_READMES) {
    const p = join(pkgRoot, name)
    if (!read.exists(p)) continue
    const badge = readBadge(read.readFile(p))
    if (badge) badged.push({ name, badge })
  }
  if (badged.length === 0) return { ok: true, violations: [] }

  const receiptPath = join(pkgRoot, RECEIPT_FILE)
  if (!read.exists(receiptPath)) {
    return { ok: false, violations: [{ code: 'badge-no-receipt', detail: `README carries a test badge but ${RECEIPT_FILE} is missing — the number must come from a measured run (badge.mjs --from-vitest)` }] }
  }
  let receipt
  try {
    receipt = JSON.parse(read.readFile(receiptPath))
  } catch (err) {
    return { ok: false, violations: [{ code: 'badge-bad-receipt', detail: `${RECEIPT_FILE} unparseable: ${err && err.message}` }] }
  }
  for (const { name, badge } of badged) {
    if (badge.total !== receipt.tests || badge.shown !== receipt.tests) {
      violations.push({ code: 'badge-stale', detail: `${name} badge says ${badge.shown}/${badge.total} but the measured receipt says ${receipt.tests} — rewrite it from the receipt, never by hand` })
    }
  }
  return { ok: violations.length === 0, violations }
}

// ── direct run ───────────────────────────────────────────────────────────────
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i > -1 ? argv[i + 1] : undefined
  }

  if (argv.includes('--check')) {
    const { ok, violations } = checkBadge({ pkgRoot })
    for (const v of violations) process.stderr.write(`  [${v.code}] ${v.detail}\n`)
    process.stdout.write(`${violations.length}\n`)
    process.exit(ok ? 0 : 1)
  }

  let measured
  try {
    if (flag('--from-vitest')) measured = parseVitestJson(readFileSync(resolve(flag('--from-vitest')), 'utf8'))
    else if (flag('--from-suite')) measured = parseSuiteSpec(flag('--from-suite'))
    else {
      process.stderr.write('usage: badge.mjs --from-vitest <json> | --from-suite <tests>/<files> | --check\n')
      process.exit(2)
    }
  } catch (err) {
    process.stderr.write(`badge: ${err && err.message}\n`)
    process.exit(1)
  }

  writeFileSync(join(pkgRoot, RECEIPT_FILE), JSON.stringify(buildReceipt(measured), null, 2) + '\n')
  for (const name of BADGE_READMES) {
    const p = join(pkgRoot, name)
    if (!existsSync(p)) continue
    const { text, replaced } = applyBadge(readFileSync(p, 'utf8'), measured.tests)
    writeFileSync(p, text)
    process.stdout.write(`${name}: ${replaced} badge site(s) -> ${measured.tests}\n`)
  }
  process.stdout.write(`receipt: ${measured.tests} tests / ${measured.files} files\n`)
}
