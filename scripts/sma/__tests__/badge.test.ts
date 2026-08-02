/**
 * Tests for badge.mjs — the README test badge written from a measured receipt.
 *
 *   - Test 1: applyBadge rewrites BOTH the shields URL and the alt text.
 *   - Test 2: the ru README's Cyrillic alt text is rewritten too (README law).
 *   - Test 3: parseVitestJson takes the counts from a green run.
 *   - Test 4: parseVitestJson REFUSES a red run — no badge from a failing suite.
 *   - Test 5: parseSuiteSpec parses <tests>/<files> and rejects junk.
 *   - Test 6: checkBadge passes when README and receipt agree.
 *   - Test 7: checkBadge flags a hand-edited (stale) badge.
 *   - Test 8: checkBadge flags a missing receipt — the number must be measured.
 */

import { describe, it, expect } from 'vitest'
import { applyBadge, readBadge, parseVitestJson, parseSuiteSpec, checkBadge, buildReceipt, RECEIPT_FILE } from '../lib/badge.mjs'

const README_EN = `<p align="center">
  <img src="https://img.shields.io/badge/tests-876%2F876-3CC0A0" alt="tests 876/876">
</p>`

const README_RU = `<p align="center">
  <img src="https://img.shields.io/badge/tests-876%2F876-3CC0A0" alt="тесты 876/876">
</p>`

/** An in-memory io for checkBadge, keyed by POSIX-ish relative name. */
function ioOf(files: Record<string, string>) {
  const norm = (p: string) => p.split(/[\\/]/).pop() as string
  return {
    exists: (p: string) => norm(p) in files,
    readFile: (p: string) => files[norm(p)],
  }
}

describe('badge.mjs — the badge comes from a measured receipt', () => {
  it('Test 1: applyBadge rewrites the shields URL and the alt text together', () => {
    const { text, replaced } = applyBadge(README_EN, 1318)
    expect(replaced).toBe(2)
    expect(text).toContain('badge/tests-1318%2F1318-')
    expect(text).toContain('alt="tests 1318/1318"')
    expect(text).not.toContain('876')
    expect(readBadge(text)).toEqual({ shown: 1318, total: 1318 })
  })

  it('Test 2: the ru README Cyrillic alt text is rewritten too', () => {
    const { text, replaced } = applyBadge(README_RU, 1318)
    expect(replaced).toBe(2)
    expect(text).toContain('alt="тесты 1318/1318"')
    expect(text).not.toContain('876')
  })

  it('Test 3: parseVitestJson counts FILES from testResults, not describe blocks', () => {
    const json = JSON.stringify({
      numTotalTests: 1318,
      numPassedTests: 1318,
      numFailedTests: 0,
      numTotalTestSuites: 743, // describe blocks — the trap
      testResults: Array.from({ length: 91 }, () => ({ status: 'passed' })),
    })
    expect(parseVitestJson(json)).toEqual({ tests: 1318, files: 91 })
  })

  it('Test 4: parseVitestJson REFUSES a red run — no badge from a failing suite', () => {
    const red = JSON.stringify({
      numTotalTests: 1318,
      numPassedTests: 1316,
      numFailedTests: 2,
      testResults: Array.from({ length: 91 }, () => ({ status: 'passed' })),
    })
    expect(() => parseVitestJson(red)).toThrow(/non-green/)
  })

  it('Test 5: parseSuiteSpec parses <tests>/<files> and rejects junk', () => {
    expect(parseSuiteSpec('1318/91')).toEqual({ tests: 1318, files: 91 })
    expect(() => parseSuiteSpec('1318')).toThrow(/expects <tests>\/<files>/)
  })

  it('Test 6: checkBadge passes when both READMEs agree with the receipt', () => {
    const io = ioOf({
      [RECEIPT_FILE]: JSON.stringify(buildReceipt({ tests: 1318, files: 91 })),
      'README.md': applyBadge(README_EN, 1318).text,
      'README.ru.md': applyBadge(README_RU, 1318).text,
    })
    expect(checkBadge({ pkgRoot: '/pkg', io })).toEqual({ ok: true, violations: [] })
  })

  it('Test 7: checkBadge flags a hand-edited badge as stale', () => {
    const io = ioOf({
      [RECEIPT_FILE]: JSON.stringify(buildReceipt({ tests: 1318, files: 91 })),
      'README.md': README_EN, // still 876 — typed by hand, never measured
      'README.ru.md': applyBadge(README_RU, 1318).text,
    })
    const res = checkBadge({ pkgRoot: '/pkg', io })
    expect(res.ok).toBe(false)
    expect(res.violations).toHaveLength(1)
    expect(res.violations[0].code).toBe('badge-stale')
    expect(res.violations[0].detail).toContain('876')
  })

  it('Test 8: checkBadge flags a missing receipt — the number must be measured', () => {
    const io = ioOf({ 'README.md': README_EN })
    const res = checkBadge({ pkgRoot: '/pkg', io })
    expect(res.ok).toBe(false)
    expect(res.violations[0].code).toBe('badge-no-receipt')
  })

  it('Test 9: a project with NO badge is not bound by the law (no receipt demanded)', () => {
    const io = ioOf({ 'README.md': '# a project that makes no public test claim' })
    expect(checkBadge({ pkgRoot: '/pkg', io })).toEqual({ ok: true, violations: [] })
  })
})
