/**
 * Tests for scripts/sma/lib/baseline.mjs — the measurement orchestrator (track A).
 *
 *   - Test 1 (captureRetrieval shape + math): the documented report shape over a fixture
 *     corpus + fixture gold cases; recall and critical_miss_rate are the documented fractions.
 *   - Test 2 (critical-miss path): a gold case whose critical note never loads lands in
 *     critical_misses AND raises critical_miss_rate.
 *   - Test 3 (determinism): two runs over the same inputs are deep-equal AND byte-equal.
 *   - Test 4 (receipt-recordability): every capture carries a check_command that passes the
 *     SAFE_COMMAND allowlist and can be recorded by receipts.recordReceipt unmodified.
 *   - Test 5 (context cost delegates): captureContextCost's numbers ARE economy.corpusStats'
 *     numbers, stamped with the same estimator version + caveat.
 *   - Test 6 (no parallel estimator): baseline.mjs imports economy.mjs and implements no
 *     token counting of its own (source assertion).
 *   - Test 7 (honest empties): zero cases / zero expected notes report null rates, never a
 *     fabricated 1.0; a missing cases file is an honest empty report, not a throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { captureRetrieval, captureContextCost } from '../lib/baseline.mjs'
import { corpusStats, ESTIMATOR_VERSION, APPROX_CAVEAT } from '../lib/economy.mjs'
import { isSafeCommand } from '../lib/predict.mjs'
import { recordReceipt } from '../lib/receipts.mjs'

const EMDASH = String.fromCharCode(0x2014)

const TAGS =
  `## area\n- crm ${EMDASH} customer relationship\n- auth ${EMDASH} authentication\n\n## kind\n- bug-lesson ${EMDASH} a burn\n`

let dir: string
let corpusDir: string
let casesPath: string

function writeNote(file: string, description: string, tags: string[], importance: number) {
  const fm = ['---', `description: ${description}`, 'kind: reference', `tags: [${tags.join(', ')}]`, `importance: ${importance}`, '---', 'body']
  writeFileSync(join(corpusDir, file), fm.join('\n') + '\n', 'utf8')
}

function writeCases(lines: object[]) {
  writeFileSync(casesPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-baseline-'))
  corpusDir = join(dir, 'memory')
  casesPath = join(dir, 'cases.jsonl')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(join(corpusDir, 'TAGS.md'), TAGS, 'utf8')
  writeFileSync(join(corpusDir, 'MEMORY.md'), '# index\n- a core line\n- another core line\n', 'utf8')
  writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9)
  writeNote('crm-detail.md', 'a crm periphery note', ['crm'], 5)
  writeNote('auth-detail.md', 'an auth note a crm task never names', ['auth'], 3)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const opts = () => ({ corpusDir, casesPath, tagsPath: join(corpusDir, 'TAGS.md'), commit: 'c' })

describe('captureRetrieval — report shape and recall math (Tests 1-2)', () => {
  it('reports hits, misses, critical misses and the documented fractions', () => {
    writeCases([
      // 2 of 3 expected notes load; the critical one does not
      { task: 'fix the crm handler', expected_notes: ['core-rule.md', 'crm-detail.md', 'auth-detail.md'], critical_notes: ['auth-detail.md'], forbidden_notes: [] },
      // everything expected loads (CORE always does)
      { task: 'read the crm rule', expected_notes: ['core-rule.md'], critical_notes: ['core-rule.md'], forbidden_notes: [] },
    ])

    const r = captureRetrieval(opts())

    expect(r.metric).toBe('retrieval-recall')
    expect(r.cases).toBe(2)
    expect(r.expected).toBe(4)
    expect(r.hits).toBe(3)
    expect(r.core_loaded).toEqual(['core-rule.md'])

    expect(r.misses).toEqual([{ case: 'fix the crm handler', missing_notes: ['auth-detail.md'] }])
    expect(r.critical_misses).toEqual([{ case: 'fix the crm handler', missing_notes: ['auth-detail.md'] }])
    expect(r.forbidden_hits).toEqual([])

    // recall = hit expected notes / all expected notes; critical_miss_rate = cases with a
    // critical miss / cases
    expect(r.summary.recall).toBeCloseTo(0.75, 6)
    expect(r.summary.critical_miss_rate).toBeCloseTo(0.5, 6)
  })

  it('a forbidden note that loads anyway is reported', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['crm-detail.md'], critical_notes: [], forbidden_notes: ['core-rule.md'] }])
    const r = captureRetrieval(opts())
    expect(r.forbidden_hits).toEqual([{ case: 'fix the crm handler', forbidden_notes: ['core-rule.md'] }])
    expect(r.summary.critical_miss_rate).toBe(0)
  })
})

describe('determinism (Test 3)', () => {
  it('two runs over the same inputs produce identical report bytes', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['core-rule.md', 'auth-detail.md'], critical_notes: ['auth-detail.md'], forbidden_notes: [] }])

    const a = captureRetrieval(opts())
    const b = captureRetrieval(opts())
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/) // no clock in the bytes

    const c1 = captureContextCost({ corpusDir })
    const c2 = captureContextCost({ corpusDir })
    expect(JSON.stringify(c1)).toBe(JSON.stringify(c2))
    expect(JSON.stringify(c1)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })
})

describe('receipt-recordability (Test 4)', () => {
  it('both captures carry an allowlist-safe check_command recordReceipt accepts', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] }])
    const reports = [captureRetrieval(opts()), captureContextCost({ corpusDir })]

    for (const r of reports) {
      expect(typeof r.check_command).toBe('string')
      expect(r.check_command.startsWith('node scripts/sma/cli.mjs baseline')).toBe(true)
      expect(isSafeCommand(r.check_command)).toBe(true)

      const rec = recordReceipt({
        entry: { id: `BASE-${r.metric}`, assertion: `the ${r.metric} measurement re-runs`, check_command: r.check_command },
        runCommand: () => ({ stdout: 'ok\n', exitCode: 0 }),
      })
      expect(rec.error).toBeUndefined()
      expect(rec.receipt?.expected_sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('captureContextCost — delegation to the economy estimator (Tests 5-6)', () => {
  it('carries corpusStats numbers verbatim, with the estimator version and caveat', () => {
    const stats = corpusStats({ corpusDir })
    const r = captureContextCost({ corpusDir })

    expect(r.metric).toBe('context-cost')
    expect(r.totals).toEqual(stats.totals)
    expect(r.estimator_version).toBe(ESTIMATOR_VERSION)
    expect(r.caveat).toBe(APPROX_CAVEAT)

    // per_file lists MEMORY.md as the core load plus every note/index, tokens verbatim
    const core = r.per_file.find((f: { file: string }) => f.file === 'MEMORY.md')
    expect(core).toMatchObject({ kind: 'core', tokens: stats.core })
    const note = r.per_file.find((f: { file: string }) => f.file === 'crm-detail.md')
    expect(note?.kind).toBe('note')
    expect(note?.tokens).toBe(stats.notes.find((n: { file: string }) => n.file === 'crm-detail.md')?.tokens)
    expect(r.per_file.filter((f: { kind: string }) => f.kind === 'note')).toHaveLength(stats.notes.length)
  })

  it('implements no token counter of its own — the estimator is imported (source assertion)', () => {
    const src = readFileSync(fileURLToPath(new URL('../lib/baseline.mjs', import.meta.url)), 'utf8')
    expect(src).toMatch(/from '\.\/economy\.mjs'/)
    expect(src).toMatch(/corpusStats/)
    // no parallel byte/token math anywhere in this module
    expect(src).not.toMatch(/Buffer\.byteLength/)
    expect(src).not.toMatch(/function estimateTokens/)
  })
})

describe('honest empties (Test 7)', () => {
  it('reports null rates instead of a fabricated 1.0, and survives a missing cases file', () => {
    writeCases([])
    const empty = captureRetrieval(opts())
    expect(empty.cases).toBe(0)
    expect(empty.summary.recall).toBeNull()
    expect(empty.summary.critical_miss_rate).toBeNull()

    const absent = captureRetrieval({ ...opts(), casesPath: join(dir, 'no-such-file.jsonl') })
    expect(absent.cases).toBe(0)
    expect(absent.summary.recall).toBeNull()

    // a corpus with no MEMORY.md reports an honest null core, never 0-as-if-measured
    const bare = mkdtempSync(join(tmpdir(), 'sma-baseline-bare-'))
    try {
      const cost = captureContextCost({ corpusDir: bare })
      expect(cost.totals.core).toBeNull()
      expect(cost.per_file).toEqual([])
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('skips corrupt gold-case lines instead of failing the capture', () => {
    writeFileSync(
      casesPath,
      [JSON.stringify({ task: 'fix the crm handler', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] }), 'not json', ''].join('\n'),
      'utf8',
    )
    const r = captureRetrieval(opts())
    expect(r.cases).toBe(1)
    expect(r.corrupt_lines).toBe(1)
    expect(r.summary.recall).toBe(1)
  })
})
