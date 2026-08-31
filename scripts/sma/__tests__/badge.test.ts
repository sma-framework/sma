/**
 * Tests for badge.mjs — the README test badge written from a measured receipt.
 *
 *   - Test 1: applyBadge rewrites BOTH the shields URL and the alt text.
 *   - Test 2: the ru README's Cyrillic alt text is rewritten too (README law).
 *   - Test 3: parseVitestJson takes the counts from a green run.
 *   - Test 4: parseVitestJson REFUSES a red run — no badge from a failing suite.
 *   - Test 5: the hand-typed door is closed — no number reaches the receipt by argv.
 *   - Test 6: checkBadge passes when README and receipt agree.
 *   - Test 7: checkBadge flags a hand-edited (stale) badge.
 *   - Test 8: checkBadge flags a missing receipt — the number must be measured.
 *   - Test 9: a project with no badge is not bound by the law.
 *
 * The blind spot this file also pins down: README and receipt can be wrong TOGETHER
 * (one provisional number written into both), and a check that only compares them is
 * silent. Tests 10-21 cover the two ways out — the cheap provenance guard (the receipt
 * knows WHICH commit it measured) and the conclusive one (--verify-live re-measures).
 *
 * Tests 17 and 26-30 pin what that guard is WORTH. A guard that only warns is a guard
 * nobody acts on: a receipt measured on a dirty tree, at a commit the product had moved
 * far past, sat behind a green `npm test` and put its number in the shop window. So the
 * two verdicts that are WRONG rather than merely unverified — measured elsewhere,
 * measured dirty — fail the plain check, while the commit that carries the measurement
 * itself is passed over, because otherwise the rule could not be satisfied by anyone.
 */

import { describe, it, expect } from 'vitest'
import {
  applyBadge,
  readBadge,
  parseVitestJson,
  checkBadge,
  buildReceipt,
  checkReceiptFreshness,
  checkReceiptCleanliness,
  readChangedSince,
  resolveMeasurement,
  verifyLive,
  defaultRunSuite,
  readHead,
  RECEIPT_FILE,
} from '../lib/badge.mjs'

const README_EN = `<p align="center">
  <img src="https://img.shields.io/badge/tests-876%2F876-3CC0A0" alt="tests 876/876">
</p>`

const README_RU = `<p align="center">
  <img src="https://img.shields.io/badge/tests-876%2F876-3CC0A0" alt="тесты 876/876">
</p>`

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/** A green vitest JSON report; `over` patches any field for the negative cases. */
function report(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    numTotalTests: 1866,
    numPassedTests: 1866,
    numFailedTests: 0,
    numTotalTestSuites: 740, // describe blocks — the trap
    startTime: 2_000_000,
    success: true,
    testResults: Array.from({ length: 116 }, () => ({ status: 'passed', assertionResults: [] })),
    ...over,
  })
}

/** An in-memory io for checkBadge/verifyLive, keyed by POSIX-ish relative name. */
function ioOf(files: Record<string, string>) {
  const norm = (p: string) => p.split(/[\\/]/).pop() as string
  return {
    exists: (p: string) => norm(p) in files,
    readFile: (p: string) => files[norm(p)],
  }
}

/** The incident shape: README + receipt agreeing on a number nothing ever measured. */
function agreeingPair(n: number, receipt: Record<string, unknown> = {}) {
  return ioOf({
    [RECEIPT_FILE]: JSON.stringify({ tests: n, files: 116, source: 'vitest', ...receipt }),
    'README.md': applyBadge(README_EN, n).text,
    'README.ru.md': applyBadge(README_RU, n).text,
  })
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
    expect(parseVitestJson(report())).toEqual({ tests: 1866, files: 116, startedAt: 2_000_000 })
  })

  it('Test 4: parseVitestJson REFUSES a red run — no badge from a failing suite', () => {
    expect(() => parseVitestJson(report({ numPassedTests: 1864, numFailedTests: 2 }))).toThrow(/non-green/)
  })

  it('Test 5: the hand-typed door is closed — a number cannot arrive by argv', () => {
    expect(() => resolveMeasurement({ argv: ['--from-suite', '1880/116'], readFile: () => report() })).toThrow(/--from-suite/)
    expect(() => resolveMeasurement({ argv: [], readFile: () => report() })).toThrow(/--from-vitest/)
  })

  it('Test 6: checkBadge passes when both READMEs agree with the receipt', () => {
    const io = ioOf({
      [RECEIPT_FILE]: JSON.stringify(buildReceipt({ tests: 1318, files: 91 })),
      'README.md': applyBadge(README_EN, 1318).text,
      'README.ru.md': applyBadge(README_RU, 1318).text,
    })
    expect(checkBadge({ pkgRoot: '/pkg', io })).toEqual({ ok: true, violations: [], warnings: [] })
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
    expect(checkBadge({ pkgRoot: '/pkg', io })).toEqual({ ok: true, violations: [], warnings: [] })
  })
})

describe('badge.mjs — only a finished, live run may write the receipt', () => {
  it('Test 10: a file that failed to LOAD makes the run red even at numFailedTests 0', () => {
    // The real shape: a test file with a syntax error reports status "failed" with zero
    // assertions, so its tests never enter numTotalTests. Counting only numFailedTests
    // reads that as green — and stamps a SHRUNKEN badge from a broken suite.
    const loadFailure = report({
      success: false,
      testResults: [
        ...Array.from({ length: 115 }, () => ({ status: 'passed', assertionResults: [] })),
        { status: 'failed', name: 'daemon/__tests__/parity-check.test.ts', message: 'Invalid or unexpected token', assertionResults: [] },
      ],
    })
    expect(() => parseVitestJson(loadFailure)).toThrow(/did not pass/)
  })

  it('Test 11: a run the runner itself marked failed is refused', () => {
    expect(() => parseVitestJson(report({ success: false }))).toThrow(/success/)
  })

  it('Test 12: a run that collected no tests is not a measurement', () => {
    expect(() => parseVitestJson(report({ numTotalTests: 0, numPassedTests: 0, testResults: [] }))).toThrow(/no tests/)
  })

  it('Test 13: a report that PREDATES HEAD measured older code — refused', () => {
    const head = { sha: SHA_A, dirty: false, committedAt: 5_000_000 } // committed after the run
    expect(() =>
      resolveMeasurement({ argv: ['--from-vitest', 'r.json'], readFile: () => report(), head }),
    ).toThrow(/predates/)
  })

  it('Test 14: a live report passes and carries the run start time into the receipt', () => {
    const head = { sha: SHA_A, dirty: false, committedAt: 1_000_000 }
    const measured = resolveMeasurement({ argv: ['--from-vitest', 'r.json'], readFile: () => report(), head })
    expect(measured).toEqual({ tests: 1866, files: 116, startedAt: 2_000_000 })
    const receipt = buildReceipt({ ...measured, head })
    expect(receipt).toMatchObject({ tests: 1866, files: 116, commit: SHA_A, dirty: false, source: 'vitest' })
    expect(receipt.runStartedAt).toBe(new Date(2_000_000).toISOString())
  })

  it('Test 15: with no git answer the receipt records no provenance — never a fake sha', () => {
    expect(readHead({ exec: () => { throw new Error('not a git repository') } })).toBe(null)
    expect(buildReceipt({ tests: 1866, files: 116 })).toMatchObject({ commit: null, dirty: null })
    const head = readHead({
      exec: (args: string[]) =>
        args[0] === 'rev-parse' ? `${SHA_B}\n` : args[0] === 'log' ? '1700000000\n' : ' M README.md\n',
    })
    expect(head).toEqual({ sha: SHA_B, dirty: true, committedAt: 1_700_000_000_000 })
  })
})

describe('badge.mjs — the consistent-but-wrong pair (the blind spot)', () => {
  it('Test 16: README and receipt can agree on a number nothing measured', () => {
    // Both sides carry 1880 while the suite really has 1866: comparing them is silent.
    expect(checkBadge({ pkgRoot: '/pkg', io: agreeingPair(1880, { commit: SHA_A }) }).ok).toBe(true)
  })

  it('Test 17: a receipt measured at another commit FAILS the plain check — no warning', () => {
    // The incident this test was written from: badge and receipt agreed, the receipt had
    // been measured on a commit the product had long moved past, and drift was only a
    // WARNING outside the release gate — so `npm test` stayed green over a number that
    // described nothing standing in the tree.
    const io = agreeingPair(1880, { commit: SHA_A })
    const head = { sha: SHA_B, dirty: false, committedAt: 3_000_000 } // the tree moved on
    const res = checkBadge({ pkgRoot: '/pkg', io, head, changedSince: ['daemon/src/queue/lease.mjs'] })
    expect(res.ok).toBe(false)
    expect(res.violations.map((v: { code: string }) => v.code)).toContain('badge-receipt-drifted')
    expect(res.warnings).toEqual([]) // it is not filed as advice any more
    expect(res.violations[0].detail).toContain('daemon/src/queue/lease.mjs')
    // and --strict can only be as strict, never softer
    expect(checkBadge({ pkgRoot: '/pkg', io, head, changedSince: ['a.ts'], strict: true }).ok).toBe(false)
  })

  it('Test 18: a receipt with no provenance cannot be judged fresh — and says so', () => {
    const io = agreeingPair(1880)
    const head = { sha: SHA_B, dirty: false, committedAt: 3_000_000 }
    expect(checkBadge({ pkgRoot: '/pkg', io, head }).warnings.map((w: { code: string }) => w.code)).toContain('badge-receipt-no-provenance')
    expect(checkBadge({ pkgRoot: '/pkg', io, head, strict: true }).ok).toBe(false)
  })

  it('Test 19: a dirty measurement is a verdict of its own — no git needed to reach it', () => {
    // The receipt says it itself: the run covered files that are in no commit. Nothing
    // can name WHAT was measured, so the number may not be published — and the check
    // does not need a repository to know that.
    const dirty = checkReceiptCleanliness({ receipt: { tests: 1866, commit: SHA_A, dirty: true } })
    expect(dirty.map((f: { code: string }) => f.code)).toEqual(['badge-receipt-dirty'])
    expect(dirty[0].hard).toBe(true)
    expect(checkReceiptCleanliness({ receipt: { tests: 1866, commit: SHA_A, dirty: false } })).toEqual([])
    // freshness answers the OTHER question and stays quiet about a clean, matching pair
    expect(checkReceiptFreshness({ receipt: { tests: 1866, commit: SHA_A, dirty: false }, head: { sha: SHA_A, dirty: false, committedAt: 1 } })).toEqual([])
    // no git answer -> unverified, never "fresh"
    expect(checkReceiptFreshness({ receipt: { commit: SHA_A }, head: null }).map((f: { code: string }) => f.code)).toEqual(['badge-head-unknown'])
  })

  it('Test 20: without a head the freshness verdict is not computed at all', () => {
    // package-check calls checkBadge WITHOUT a head: publishability must not depend on
    // git, and its violation count (the scorer contract) must not grow behind its back.
    const res = checkBadge({ pkgRoot: '/pkg', io: agreeingPair(1880, { commit: SHA_A }) })
    expect(res).toEqual({ ok: true, violations: [], warnings: [] })
  })
})

describe('badge.mjs — a number measured somewhere else is not a number about this tree', () => {
  it('Test 26: a receipt measured on a DIRTY worktree fails the plain check', () => {
    // Even with HEAD matching to the letter: the run ran over uncommitted files, so the
    // published number counts something nobody can name, reproduce, or review.
    const io = agreeingPair(1880, { commit: SHA_A, dirty: true })
    const head = { sha: SHA_A, dirty: true, committedAt: 3_000_000 }
    const res = checkBadge({ pkgRoot: '/pkg', io, head, changedSince: [] })
    expect(res.ok).toBe(false)
    expect(res.violations.map((v: { code: string }) => v.code)).toEqual(['badge-receipt-dirty'])
    expect(res.violations[0].detail).toMatch(/commit first/)
  })

  it('Test 27: the release gate refuses a dirty receipt WITHOUT git — and the bare count does not move', () => {
    // package-check passes no head (publishability is a pure file check) but does pass
    // --strict. The dirty flag is in the receipt, so the gate can refuse it in a tree with
    // no history at all — while the plain count stays exactly what the scorer knew.
    const io = agreeingPair(1880, { commit: SHA_A, dirty: true })
    const counted = checkBadge({ pkgRoot: '/pkg', io })
    expect(counted.violations).toEqual([])
    expect(counted.warnings.map((w: { code: string }) => w.code)).toEqual(['badge-receipt-dirty'])
    const gated = checkBadge({ pkgRoot: '/pkg', io, strict: true })
    expect(gated.ok).toBe(false)
    expect(gated.violations.map((v: { code: string }) => v.code)).toEqual(['badge-receipt-dirty'])
  })

  it('Test 28: the measurement LANDING is not drift — a stamp always makes one more commit', () => {
    // Stamping writes the receipt and both READMEs, and that commit moves HEAD past the
    // commit the receipt names. If that counted as drift the rule could never be
    // satisfied by anyone, and a rule nobody can satisfy is turned off within a week.
    const io = agreeingPair(1880, { commit: SHA_A, dirty: false })
    const head = { sha: SHA_B, dirty: false, committedAt: 3_000_000 }
    const landing = ['test-receipt.json', 'README.md', 'README.ru.md', 'docs/master-graph.html']
    expect(checkBadge({ pkgRoot: '/pkg', io, head, changedSince: landing }).ok).toBe(true)
    // prose landing with it is still not code
    expect(checkBadge({ pkgRoot: '/pkg', io, head, changedSince: [...landing, 'docs/DETAILS.md'] }).ok).toBe(true)
    // one code file among them and the number is about another tree again
    expect(checkBadge({ pkgRoot: '/pkg', io, head, changedSince: [...landing, 'scripts/sma/cli.mjs'] }).ok).toBe(false)
  })

  it('Test 29: when git cannot say what moved, the differing commit is the verdict — fail closed', () => {
    const io = agreeingPair(1880, { commit: SHA_A })
    const head = { sha: SHA_B, dirty: false, committedAt: 3_000_000 }
    for (const changedSince of [undefined, null]) {
      const res = checkBadge({ pkgRoot: '/pkg', io, head, changedSince })
      expect(res.ok).toBe(false)
      expect(res.violations.map((v: { code: string }) => v.code)).toEqual(['badge-receipt-drifted'])
    }
  })

  it('Test 30: readChangedSince asks git for the paths, and answers null when it cannot', () => {
    const calls: string[][] = []
    const changed = readChangedSince({
      commit: SHA_A,
      exec: (args: string[]) => {
        calls.push(args)
        return 'daemon/src/queue/lease.mjs\ntest-receipt.json\n\n'
      },
    })
    expect(calls).toEqual([['diff', '--name-only', SHA_A, 'HEAD']])
    expect(changed).toEqual(['daemon/src/queue/lease.mjs', 'test-receipt.json'])
    // an unknown commit, no repository, no git — never read as "nothing changed"
    expect(readChangedSince({ commit: SHA_A, exec: () => { throw new Error('bad revision') } })).toBe(null)
    expect(readChangedSince({ commit: null, exec: () => 'x' })).toBe(null)
  })
})

describe('badge.mjs — --verify-live re-measures instead of comparing two copies', () => {
  it('Test 21: a fresh run breaks the tie between a badge and a receipt that agree', () => {
    const io = agreeingPair(1880, { commit: SHA_A })
    const res = verifyLive({ pkgRoot: '/pkg', io, reportText: report() }) // the suite really has 1866
    expect(res.ok).toBe(false)
    expect(res.measured).toEqual({ tests: 1866, files: 116, startedAt: 2_000_000 })
    expect(res.violations.map((v: { code: string }) => v.code)).toEqual(['badge-live-mismatch', 'badge-live-mismatch', 'badge-live-mismatch'])
    expect(res.violations[0].detail).toContain('1880')
    expect(res.violations[0].detail).toContain('1866')
  })

  it('Test 22: an honest trio (fresh run, receipt, both READMEs) passes', () => {
    const res = verifyLive({ pkgRoot: '/pkg', io: agreeingPair(1866, { commit: SHA_A }), reportText: report() })
    expect(res).toMatchObject({ ok: true, violations: [] })
  })

  it('Test 23: handed no report, verify-live runs the suite through the injected seam', () => {
    let ran = 0
    const res = verifyLive({
      pkgRoot: '/pkg',
      io: agreeingPair(1866, { commit: SHA_A }),
      runSuite: () => {
        ran++
        return report()
      },
    })
    expect(ran).toBe(1)
    expect(res.ok).toBe(true)
  })

  it('Test 24: verify-live inherits the green law — a red run proves nothing', () => {
    expect(() =>
      verifyLive({ pkgRoot: '/pkg', io: agreeingPair(1866, { commit: SHA_A }), reportText: report({ numFailedTests: 3, numPassedTests: 1863 }) }),
    ).toThrow(/non-green/)
  })

  it('Test 25: the default runner asks the project vitest for a JSON report and reads it back', () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const text = defaultRunSuite({
      pkgRoot: '/pkg',
      exec: (cmd: string, args: string[]) => {
        calls.push({ cmd, args })
      },
      io: { readFile: () => report(), remove: () => {} },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toMatch(/^npx/)
    expect(calls[0].args.slice(0, 3)).toEqual(['vitest', 'run', '--reporter=json'])
    expect(calls[0].args[3]).toMatch(/^--outputFile=/)
    expect(parseVitestJson(text).tests).toBe(1866)
  })
})
