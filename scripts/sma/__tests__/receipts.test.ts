/**
 * Tests for scripts/sma/lib/receipts.mjs (Phase 9.2 Plan 03, Task 1).
 *
 * Structural receipts — the claims schema over the V2 coverage block:
 *   - Test 1: parseReceipts extracts a flat `receipts:` dash-list; missing file /
 *     no fence / no block -> {receipts: []} honest-empty, never a throw.
 *   - Test 2: validateReceipt rejects a missing locked field; enforces the 64-hex
 *     expected_sha256 and numeric expected_exit.
 *   - Test 3: verifyReceipts — matching hash -> 'verified'; mismatch -> 'divergent'
 *     with BOTH observed_sha256 and expected_sha256.
 *   - Test 4: a non-allowlisted check_command -> 'skipped-unsafe' and the runner
 *     is NEVER invoked (spy assertion) — the predict.mjs boundary verbatim.
 *   - Test 5: a throwing / non-conforming runner -> 'error'; verifyReceipts never throws.
 *   - Test 6: recordReceipt round-trip — record then verify with the same runner -> 'verified'.
 *   - Test 7: parseCoverage extracts {id, human_judgment} and TOLERATES nested
 *     verification sub-lists (does not break on the 6-space dedent).
 *   - Test 8: the digest binds the exact command + exit + normalized stdout —
 *     different commands NEVER share a digest (even exit-only); the same
 *     command + same output re-derives the identical digest.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  parseReceipts,
  parseCoverage,
  validateReceipt,
  observationOf,
  verifyReceipts,
  recordReceipt,
  RECEIPT_REQUIRED_FIELDS,
} from '../lib/receipts.mjs'

/** Build a SUMMARY frontmatter text with the given body lines between the fences. */
function summary(bodyLines: string[]): string {
  return ['---', ...bodyLines, '---', '', '# body'].join('\n') + '\n'
}

describe('parseReceipts', () => {
  it('extracts a flat receipts dash-list from frontmatter', () => {
    const text = summary([
      'phase: 9.2',
      'receipts:',
      '  - id: R1',
      '    assertion: the thing holds',
      '    check_command: node scripts/sma/cli.mjs chain-tip',
      '    expected_sha256: ' + 'a'.repeat(64),
      '    hash_stdout: true',
      '    coverage_id: cov-1',
      '  - id: R2',
      '    assertion: another claim',
      '    check_command: pnpm sma chain-verify --count breaks',
      '    expected_sha256: ' + 'b'.repeat(64),
    ])
    const { receipts } = parseReceipts('S.md', { readFn: () => text })
    expect(receipts).toHaveLength(2)
    expect(receipts[0].id).toBe('R1')
    expect(receipts[0].coverage_id).toBe('cov-1')
    expect(receipts[0].check_command).toBe('node scripts/sma/cli.mjs chain-tip')
    expect(receipts[1].id).toBe('R2')
  })

  it('missing file / no fence / no block -> {receipts: []}, never a throw', () => {
    expect(parseReceipts('S.md', { readFn: () => { throw new Error('ENOENT') } }).receipts).toEqual([])
    expect(parseReceipts('S.md', { readFn: () => 'no fence here' }).receipts).toEqual([])
    expect(parseReceipts('S.md', { readFn: () => summary(['phase: 9.2']) }).receipts).toEqual([])
  })
})

describe('validateReceipt', () => {
  it('rejects an entry missing a locked field and reports the missing list', () => {
    const v = validateReceipt({ id: 'R1', assertion: 'x' })
    expect(v.valid).toBe(false)
    expect(v.missing).toContain('check_command')
    expect(v.missing).toContain('expected_sha256')
    expect(RECEIPT_REQUIRED_FIELDS).toEqual(['id', 'assertion', 'check_command', 'expected_sha256'])
  })

  it('enforces 64-hex expected_sha256 and numeric expected_exit', () => {
    const bad = validateReceipt({ id: 'R', assertion: 'a', check_command: 'pnpm sma x', expected_sha256: 'ZZZ' })
    expect(bad.valid).toBe(false)
    expect(bad.errors.join(' ')).toMatch(/expected_sha256/)

    const badExit = validateReceipt({
      id: 'R', assertion: 'a', check_command: 'pnpm sma x', expected_sha256: 'a'.repeat(64), expected_exit: 'nope',
    })
    expect(badExit.valid).toBe(false)
    expect(badExit.errors.join(' ')).toMatch(/expected_exit/)

    const ok = validateReceipt({
      id: 'R', assertion: 'a', check_command: 'pnpm sma x', expected_sha256: 'a'.repeat(64), expected_exit: 0,
    })
    expect(ok.valid).toBe(true)
  })
})

describe('verifyReceipts — verified vs divergent', () => {
  it('matching observation -> verified; mismatch -> divergent with both hashes', () => {
    // hash_stdout absent -> stdout bound by default: sha256('cmd:<command>\nexit:0\n<stdout>').
    const expected = require('node:crypto')
      .createHash('sha256')
      .update(observationOf({ command: 'pnpm sma chain-verify --count breaks', exitCode: 0, stdout: 'anything' }), 'utf8')
      .digest('hex')
    const receipts = [
      { id: 'R1', assertion: 'exits clean', check_command: 'pnpm sma chain-verify --count breaks', expected_sha256: expected },
      { id: 'R2', assertion: 'stale hash', check_command: 'pnpm sma chain-verify --count breaks', expected_sha256: 'c'.repeat(64) },
    ]
    const runCommand = () => ({ stdout: 'anything', exitCode: 0 })
    const { records } = verifyReceipts({ receipts, runCommand, now: 'T' })
    expect(records[0].verdict).toBe('verified')
    expect(records[1].verdict).toBe('divergent')
    expect(records[1].observed_sha256).toBe(expected)
    expect(records[1].expected_sha256).toBe('c'.repeat(64))
  })
})

describe('verifyReceipts — skipped-unsafe (the boundary)', () => {
  it('a non-allowlisted check_command scores skipped-unsafe and never invokes the runner', () => {
    const runCommand = vi.fn(() => ({ stdout: '', exitCode: 0 }))
    const receipts = [
      { id: 'R1', assertion: 'evil', check_command: 'git push --force origin main', expected_sha256: 'd'.repeat(64) },
      { id: 'R2', assertion: 'smuggled', check_command: 'node scripts/sma/x.mjs; rm -rf /', expected_sha256: 'e'.repeat(64) },
    ]
    const { records } = verifyReceipts({ receipts, runCommand, now: 'T' })
    expect(records[0].verdict).toBe('skipped-unsafe')
    expect(records[1].verdict).toBe('skipped-unsafe')
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('verifyReceipts — error, never throws', () => {
  it('a throwing runner or non-conforming shape -> error verdict; verifyReceipts never throws', () => {
    const thrower = () => { throw new Error('boom') }
    const shapeless = () => ({ stdout: 'x' }) // no exitCode
    const receipts = [
      { id: 'R1', assertion: 'a', check_command: 'pnpm sma chain-tip', expected_sha256: 'a'.repeat(64) },
    ]
    const r1 = verifyReceipts({ receipts, runCommand: thrower, now: 'T' })
    expect(r1.records[0].verdict).toBe('error')
    const r2 = verifyReceipts({ receipts, runCommand: shapeless, now: 'T' })
    expect(r2.records[0].verdict).toBe('error')
  })
})

describe('recordReceipt round-trip', () => {
  it('records expected_sha256 from a live run, then verifies verified with the same runner', () => {
    const runCommand = () => ({ stdout: 'deterministic\noutput\n', exitCode: 0 })
    const rec = recordReceipt({
      entry: { id: 'R1', assertion: 'produces the output', check_command: 'node scripts/sma/cli.mjs chain-tip', hash_stdout: true },
      runCommand,
    })
    expect(rec.error).toBeUndefined()
    expect(rec.receipt.expected_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rec.receipt.expected_exit).toBe(0)

    const { records } = verifyReceipts({ receipts: [rec.receipt], runCommand, now: 'T' })
    expect(records[0].verdict).toBe('verified')
  })

  it('refuses to record a non-allowlisted command (forgery is structurally impossible)', () => {
    const runCommand = vi.fn(() => ({ stdout: '', exitCode: 0 }))
    const rec = recordReceipt({ entry: { id: 'R', assertion: 'x', check_command: 'rm -rf /' }, runCommand })
    expect(rec.receipt).toBeUndefined()
    expect(rec.error).toMatch(/allowlist/)
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('parseCoverage — tolerates nested verification sub-lists', () => {
  it('extracts {id, human_judgment} and does not break on the 6-space dedent', () => {
    const text = summary([
      'phase: 9.2',
      'coverage:',
      '  - id: cov-1',
      '    description: a machine claim',
      '    requirement: R-1',
      '    human_judgment: false',
      '    verification:',
      '      - kind: test',
      '        ref: foo.test.ts',
      '        status: pass',
      '  - id: cov-2',
      '    description: a human judgment call',
      '    human_judgment: true',
      '    verification:',
      '      - kind: manual',
      '        ref: eyeball',
      '        status: pass',
      '  - id: cov-3',
      '    description: default machine (no human_judgment key)',
    ])
    const { coverage } = parseCoverage('S.md', { readFn: () => text })
    expect(coverage.map((c) => c.id)).toEqual(['cov-1', 'cov-2', 'cov-3'])
    expect(coverage[0].human_judgment).toBe(false)
    expect(coverage[1].human_judgment).toBe(true)
    expect(coverage[2].human_judgment).toBe(false) // absent -> machine-verifiable by default
  })
})

describe('observationOf — binds command + exit + normalized stdout', () => {
  it('folds command, exit and normalized stdout by default; explicit hashStdout:false keeps cmd+exit', () => {
    expect(observationOf({ command: 'pnpm sma chain-tip', exitCode: 0, stdout: '' })).toBe('cmd:pnpm sma chain-tip\nexit:0\n')
    expect(observationOf({ command: 'pnpm sma chain-tip', exitCode: 1, stdout: 'x\r\ny\r\n' })).toBe('cmd:pnpm sma chain-tip\nexit:1\nx\ny')
    expect(observationOf({ command: 'pnpm sma chain-tip', exitCode: 0, stdout: 'noise', hashStdout: false })).toBe('cmd:pnpm sma chain-tip\nexit:0')
  })
})

describe('digest degeneracy is fixed (Test 8) — a receipt binds WHAT ran and WHAT it printed', () => {
  const runnerWith = (stdout: string) => () => ({ stdout, exitCode: 0 })

  it('(a) different commands -> different digests, same runner output and exit', () => {
    const a = recordReceipt({
      entry: { id: 'A', assertion: 'a', check_command: 'node scripts/sma/cli.mjs preship --count' },
      runCommand: runnerWith('0\n'),
    })
    const b = recordReceipt({
      entry: { id: 'B', assertion: 'b', check_command: 'node scripts/sma/cli.mjs chain-verify --count breaks' },
      runCommand: runnerWith('0\n'),
    })
    expect(a.receipt.expected_sha256).not.toBe(b.receipt.expected_sha256)
  })

  it('(a2) exit-only receipts still bind the command — no shared digest across commands', () => {
    const a = recordReceipt({
      entry: { id: 'A', assertion: 'a', check_command: 'node scripts/sma/cli.mjs preship --count', hash_stdout: false },
      runCommand: runnerWith('0\n'),
    })
    const b = recordReceipt({
      entry: { id: 'B', assertion: 'b', check_command: 'node scripts/sma/cli.mjs chain-verify --count breaks', hash_stdout: false },
      runCommand: runnerWith('1\n'),
    })
    expect(a.receipt.expected_sha256).not.toBe(b.receipt.expected_sha256)
    // exit-only really is exit-only: same command, different stdout -> same digest.
    const a2 = recordReceipt({
      entry: { id: 'A2', assertion: 'a', check_command: 'node scripts/sma/cli.mjs preship --count', hash_stdout: false },
      runCommand: runnerWith('totally different\n'),
    })
    expect(a2.receipt.expected_sha256).toBe(a.receipt.expected_sha256)
  })

  it('(b) same command + same output twice -> the identical digest (deterministic)', () => {
    const entry = { id: 'R', assertion: 'stable', check_command: 'pnpm sma chain-tip' }
    const one = recordReceipt({ entry: { ...entry }, runCommand: runnerWith('tip-abc\n') })
    const two = recordReceipt({ entry: { ...entry }, runCommand: runnerWith('tip-abc\n') })
    expect(one.receipt.expected_sha256).toBe(two.receipt.expected_sha256)
    // and different output for the same command -> a different digest.
    const three = recordReceipt({ entry: { ...entry }, runCommand: runnerWith('tip-DEF\n') })
    expect(three.receipt.expected_sha256).not.toBe(one.receipt.expected_sha256)
  })

  it('(c) reverify verifies a receipt produced by the fixed emit path (default stdout binding)', () => {
    const runCommand = runnerWith('deterministic\noutput\n')
    const rec = recordReceipt({
      entry: { id: 'R1', assertion: 'produces the output', check_command: 'node scripts/sma/cli.mjs chain-tip' },
      runCommand,
    })
    expect(rec.error).toBeUndefined()
    expect(rec.receipt.hash_stdout).toBe(true) // normalized to an explicit bool
    const { records } = verifyReceipts({ receipts: [rec.receipt], runCommand, now: 'T' })
    expect(records[0].verdict).toBe('verified')
  })
})

describe('release-gate commands and the --unsafe-ack waiver', () => {
  const runnerWith = (stdout: string) => () => ({ stdout, exitCode: 0 })

  it('records a receipt for a release-gate command without any ack', () => {
    const runCommand = runnerWith('ok\n')
    const rec = recordReceipt({
      entry: { id: 'R1', assertion: 'the suite passes', check_command: 'npm test' },
      runCommand,
    })
    expect(rec.error).toBeUndefined()
    expect(rec.receipt.unsafe_ack).toBeUndefined()
    const { records } = verifyReceipts({ receipts: [rec.receipt], runCommand, now: 'T' })
    expect(records[0].verdict).toBe('verified')
  })

  it('refuses an off-allowlist command without the ack, and stamps it with one', () => {
    const runCommand = runnerWith('done\n')
    const entry = { id: 'R2', assertion: 'the artifact was produced', check_command: 'make release' }

    const refused = recordReceipt({ entry: { ...entry }, runCommand })
    expect(refused.error).toMatch(/not on the SAFE_COMMAND allowlist/)
    expect(refused.receipt).toBeUndefined()

    const acked = recordReceipt({ entry: { ...entry }, runCommand, unsafeAck: true })
    expect(acked.error).toBeUndefined()
    expect(acked.receipt.unsafe_ack).toBe(true)
    expect(acked.receipt.expected_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves no stamp when the ack was not needed', () => {
    const rec = recordReceipt({
      entry: { id: 'R3', assertion: 'a', check_command: 'pnpm sma chain-tip' },
      runCommand: runnerWith('tip\n'),
      unsafeAck: true,
    })
    expect(rec.receipt.unsafe_ack).toBeUndefined()
  })

  it('an acked receipt is still never re-run at verify time — the waiver is carried, not honoured', () => {
    const runCommand = vi.fn(() => ({ stdout: 'x\n', exitCode: 0 }))
    const acked = recordReceipt({
      entry: { id: 'R4', assertion: 'a', check_command: 'make release' },
      runCommand,
      unsafeAck: true,
    })
    runCommand.mockClear()

    const { records } = verifyReceipts({ receipts: [acked.receipt], runCommand, now: 'T' })
    expect(records[0].verdict).toBe('skipped-unsafe')
    expect(records[0].unsafe_ack).toBe(true)
    expect(runCommand).not.toHaveBeenCalled()

    // Without the stamp the skip is anonymous, exactly as before.
    const plain = verifyReceipts({
      receipts: [{ ...acked.receipt, unsafe_ack: undefined }],
      runCommand,
      now: 'T',
    })
    expect(plain.records[0].verdict).toBe('skipped-unsafe')
    expect(plain.records[0].unsafe_ack).toBeUndefined()
  })

  it('reads the stamp as frontmatter delivers it — the string "true" waives, anything else does not', () => {
    const runCommand = vi.fn(() => ({ stdout: 'x\n', exitCode: 0 }))
    const base = {
      id: 'R5',
      assertion: 'a',
      check_command: 'make release',
      expected_sha256: 'a'.repeat(64),
    }
    const verdictFor = (unsafe_ack: unknown) =>
      verifyReceipts({ receipts: [{ ...base, unsafe_ack }], runCommand, now: 'T' }).records[0]

    expect(verdictFor('true').unsafe_ack).toBe(true)
    expect(verdictFor(true).unsafe_ack).toBe(true)
    expect(verdictFor('false').unsafe_ack).toBeUndefined()
    expect(verdictFor('').unsafe_ack).toBeUndefined()
    expect(verdictFor(undefined).unsafe_ack).toBeUndefined()
    expect(runCommand).not.toHaveBeenCalled()
  })
})
