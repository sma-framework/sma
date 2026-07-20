/**
 * tia.mjs — regex-based test-impact analysis (9.1-23, B17).
 *
 * The CHEAP v1 the research mandates (RESEARCH Don't-Hand-Roll, SMA-V2-CODING #5,
 * Anti-patterns): grep the changed files' exported symbols across the test files and
 * return the tests that reference any of them. NO import-graph walker, no path-alias
 * resolution, no RSC-boundary handling — those are the multi-week over-build the
 * research explicitly warns against building before the regex v1 proves value.
 *
 * TIA is an ADVISORY middle tier between "targeted tests only" (the dev loop) and the
 * full pre-push suite (the push gate). It is INTENTIONALLY under-inclusive: it can only
 * see symbols it can name and grep. Therefore EVERY output carries the disclaimer that
 * the full `pnpm test` suite remains the push gate (T-9.1-49). This module NEVER
 * presents its set as a substitute for that suite — the prohibition is load-bearing.
 *
 * Determinism: all I/O is dependency-injectable — `readFile` reads a file body,
 * `testFiles` (or a `listTestFiles` walker over `testGlobRoot`) enumerates the test
 * corpus, and the CLI derives `changedFiles` from a read-only `git diff --name-only`.
 * Node built-ins only; zero npm deps.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The single source of the advisory disclaimer. Present in every impactedTests result
 * and printed by the CLI help + every `tia` run so the push-gate rule is never blurred.
 */
export const TIA_DISCLAIMER =
  'Advisory tier only. This impact set may be under-inclusive (regex symbol match, no ' +
  'import graph) — the full pre-push suite (pnpm test) remains the push gate.'

/** A file is a test file when its name ends with the vitest test suffixes. */
export function isTestFile(path) {
  return /\.test\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(String(path))
}

/** Escape a symbol for use inside a word-boundary RegExp. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * extractExports(source) -> string[] of exported symbol names. Covers the common
 * ES-module + CommonJS shapes: `export function/const/let/var/class/type/interface NAME`,
 * `export { a, b as c }` (the alias importers actually use is captured), and
 * `module.exports.NAME` / `exports.NAME`. Regex only — good enough for the 60-70% v1.
 */
export function extractExports(source) {
  if (typeof source !== 'string' || !source) return []
  const symbols = new Set()

  const single = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g,
    /module\.exports\.([A-Za-z_$][\w$]*)/g,
    /(?:^|[^.\w])exports\.([A-Za-z_$][\w$]*)/g,
  ]
  for (const re of single) {
    let m
    while ((m = re.exec(source)) !== null) symbols.add(m[1])
  }

  // `export { foo, bar as baz }` — importers reference the alias (`baz`), so capture the
  // last identifier of each clause. Skip `export { ... } from '...'` re-exports? Those
  // still expose the names, so include them too.
  const braceRe = /export\s*\{([^}]*)\}/g
  let bm
  while ((bm = braceRe.exec(source)) !== null) {
    for (const clause of bm[1].split(',')) {
      const parts = clause.trim().split(/\s+as\s+/)
      const name = parts[parts.length - 1].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') symbols.add(name)
    }
  }

  return [...symbols]
}

/**
 * defaultListTestFiles(root, readdir) — recursively walk `root` collecting test files,
 * skipping the usual heavy/irrelevant dirs. Returns repo-relative-ish paths (as walked
 * from `root`). Fail-open: an unreadable dir contributes nothing.
 */
export function defaultListTestFiles(root, readdir = readdirSync) {
  const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.sma'])
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdir(dir, { withFileTypes: true })
    } catch {
      return // fail-open
    }
    for (const e of entries) {
      const name = e.name
      const full = join(dir, name)
      if (e.isDirectory()) {
        if (!SKIP.has(name)) walk(full)
      } else if (isTestFile(name)) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out
}

/**
 * impactedTests({ changedFiles, testFiles, testGlobRoot, readFile, listTestFiles }) ->
 * { tests, symbols, disclaimer, note? }.
 *
 *   1. Every CHANGED file that is itself a test file is always in the impact set.
 *   2. Extract the exported symbol names from every changed NON-test file.
 *   3. A test file is impacted when it references (word-boundary) any of those symbols.
 *
 * `readFile(path) -> string` (fail-open to '') and the test corpus come via DI: pass an
 * explicit `testFiles` array, or a `testGlobRoot` (walked by `listTestFiles`, default the
 * recursive fs walker). When the changed set yields no exported symbols AND no changed
 * test file, the result is the honest empty advisory with a `note` — never a silent set
 * that could be mistaken for "nothing to run".
 */
export function impactedTests(opts = {}) {
  const changedFiles = Array.isArray(opts.changedFiles) ? opts.changedFiles : []
  const readFile =
    typeof opts.readFile === 'function'
      ? opts.readFile
      : (p) => {
          try {
            return readFileSync(p, 'utf8')
          } catch {
            return ''
          }
        }

  const testFiles =
    opts.testFiles != null
      ? opts.testFiles
      : (opts.listTestFiles ?? defaultListTestFiles)(opts.testGlobRoot ?? process.cwd())

  const norm = (p) => String(p).replace(/\\/g, '/')

  // (1) changed test files are always in their own impact set.
  const impacted = new Set()
  for (const f of changedFiles) {
    if (isTestFile(f)) impacted.add(norm(f))
  }

  // (2) symbols from the changed NON-test files.
  const symbols = new Set()
  for (const f of changedFiles) {
    if (isTestFile(f)) continue
    for (const s of extractExports(readFile(f))) symbols.add(s)
  }

  // (3) grep each test file for a word-boundary reference to any changed symbol.
  if (symbols.size) {
    const symRes = [...symbols].map((s) => new RegExp('\\b' + escapeRegex(s) + '\\b'))
    for (const tf of testFiles) {
      const body = readFile(tf)
      if (!body) continue
      if (symRes.some((re) => re.test(body))) impacted.add(norm(tf))
    }
  }

  const tests = [...impacted].sort()
  const result = { tests, symbols: [...symbols].sort(), disclaimer: TIA_DISCLAIMER }

  // Honest empty advisory: nothing greppable AND no changed test file.
  if (!symbols.size && tests.length === 0) {
    result.note =
      changedFiles.length === 0
        ? 'no changed files — nothing to size (run the full suite before push).'
        : 'no symbol signal — the changed files export nothing greppable; run the full suite.'
  }

  return result
}
