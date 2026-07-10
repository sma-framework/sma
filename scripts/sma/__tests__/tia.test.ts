/**
 * Tests for scripts/sma/lib/tia.mjs (Phase 49.1 Plan 23, B17).
 *
 * Regex-based test-impact analysis — the cheap v1 (RESEARCH Don't-Hand-Roll: the
 * changed file's exported symbols grepped across test files; NO import-graph walker).
 * TIA is an ADVISORY middle tier between "targeted tests only" and the full pre-push
 * suite; every output carries the disclaimer that the full suite remains the push gate.
 *
 * fs is dependency-injected (readFile + an explicit testFiles list) so the tests are
 * deterministic and never touch the disk or git.
 */

import { describe, it, expect } from 'vitest'

import { impactedTests, extractExports, TIA_DISCLAIMER } from '../lib/tia.mjs'

/** In-memory readFile over a {path -> text} tree; suffix-matches so relative paths resolve. */
function makeReadFile(tree: Record<string, string>) {
  return (p: string) => {
    const key = String(p).replace(/\\/g, '/')
    if (key in tree) return tree[key]
    const hit = Object.keys(tree).find((k) => key.endsWith(k))
    return hit ? tree[hit] : ''
  }
}

describe('extractExports — the regex symbol scanner (B17)', () => {
  it('captures function / const / class / brace + module.exports names', () => {
    const src = [
      'export function foo() {}',
      'export const bar = 1',
      'export class Baz {}',
      'export { qux, hidden as visible }',
      'module.exports.legacy = 1',
    ].join('\n')
    const syms = extractExports(src)
    expect(syms).toEqual(expect.arrayContaining(['foo', 'bar', 'Baz', 'qux', 'visible', 'legacy']))
  })

  it('a file with no exports yields the empty set', () => {
    expect(extractExports('{ "just": "config" }')).toEqual([])
    expect(extractExports('')).toEqual([])
  })
})

describe('impactedTests — regex-based impact set (B17)', () => {
  it('Test 1: a changed source exporting foo/bar returns only tests that reference them', () => {
    const tree = {
      'src/foo.ts': 'export function foo() {}\nexport const bar = 1\n',
      'a.test.ts': "import { foo } from '../src/foo'\ndescribe('foo', () => { foo() })",
      'b.test.ts': "import { qux } from '../src/qux'\nqux()",
    }
    const res = impactedTests({
      changedFiles: ['src/foo.ts'],
      testFiles: ['a.test.ts', 'b.test.ts'],
      readFile: makeReadFile(tree),
    })
    expect(res.tests).toContain('a.test.ts')
    expect(res.tests).not.toContain('b.test.ts')
    expect(res.disclaimer).toBeTruthy()
  })

  it('Test 2: a changed test file is ALWAYS in its own impact set', () => {
    const tree = { 'x.test.ts': 'export const helper = 1\ndescribe("x", () => {})' }
    const res = impactedTests({
      changedFiles: ['x.test.ts'],
      testFiles: ['x.test.ts'],
      readFile: makeReadFile(tree),
    })
    expect(res.tests).toContain('x.test.ts')
  })

  it('Test 3: a changed file with no exports returns the empty advisory with a no-symbol note', () => {
    const tree = { 'config.json': '{ "a": 1 }', 'a.test.ts': 'describe("a", () => {})' }
    const res = impactedTests({
      changedFiles: ['config.json'],
      testFiles: ['a.test.ts'],
      readFile: makeReadFile(tree),
    })
    expect(res.tests).toEqual([])
    expect(String(res.note)).toMatch(/no symbol signal/i)
    expect(res.disclaimer).toBeTruthy()
  })

  it('Test 4: EVERY output shape carries the push-gate disclaimer', () => {
    const trees = [
      { changed: ['src/foo.ts'], testFiles: ['a.test.ts'], tree: { 'src/foo.ts': 'export const bar = 1', 'a.test.ts': 'bar' } },
      { changed: ['x.test.ts'], testFiles: ['x.test.ts'], tree: { 'x.test.ts': 'describe("x", () => {})' } },
      { changed: ['config.json'], testFiles: ['a.test.ts'], tree: { 'config.json': '{}', 'a.test.ts': 'describe("a", () => {})' } },
    ]
    for (const s of trees) {
      const res = impactedTests({ changedFiles: s.changed, testFiles: s.testFiles, readFile: makeReadFile(s.tree) })
      expect(typeof res.disclaimer).toBe('string')
      expect(res.disclaimer).toMatch(/full suite|pnpm test|push gate/i)
    }
    // The exported constant is the single source of the disclaimer text.
    expect(TIA_DISCLAIMER).toMatch(/full suite|pnpm test|push gate/i)
  })

  it('dedup + word-boundary: a symbol that is a substring of another token does not false-match', () => {
    const tree = {
      'src/mod.ts': 'export const cat = 1\n',
      'a.test.ts': 'const category = concatenate()\n', // contains "cat" as a substring only
    }
    const res = impactedTests({ changedFiles: ['src/mod.ts'], testFiles: ['a.test.ts'], readFile: makeReadFile(tree) })
    expect(res.tests).toEqual([]) // no whole-word "cat" -> not impacted
  })

  it('an empty changed set returns no tests but still carries the disclaimer', () => {
    const res = impactedTests({ changedFiles: [], testFiles: ['a.test.ts'], readFile: makeReadFile({ 'a.test.ts': 'x' }) })
    expect(res.tests).toEqual([])
    expect(res.disclaimer).toBeTruthy()
  })
})
