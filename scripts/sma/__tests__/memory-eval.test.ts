/**
 * Tests for scripts/sma/lib/memory-eval.mjs — the GOLD-SET MEASURER (canon §8).
 *
 * The benchmark of the memory layer lives HERE, next to baseline.mjs, and never inside
 * bench.mjs: the workflow scorecard prices the discipline, this prices RETRIEVAL. The
 * two answer different questions and must never share a number.
 *
 *   - Test 1 (report shape + receipt contract): the documented `memory-eval` report —
 *     recall@k, precision@k, MRR, nDCG, critical-miss, superseded-selection,
 *     contradiction-exposure, forbidden hits, abstention counters — carrying a
 *     check_command that is allowlist-safe and PATH-FREE.
 *   - Test 2 (honest empties): a set that asks no rankable question reports `null`,
 *     never a fabricated 0.0 or 1.0; zero cases is an honest empty report, not a throw.
 *   - Test 3 (rank = pack order, deterministically): a note's rank is its position in
 *     the ordered pack the REAL selection produced; two runs are byte-identical.
 *   - Test 4 (retired + contradictory delivery): superseded_selection_rate rises when a
 *     retired record is delivered; contradiction_exposure rises when both halves of a
 *     declared contradiction land in one pack.
 *   - Test 5 (floors): floorFailures(summary) against DEFAULT_FLOORS returns the
 *     violated floors and nothing else — an empty list IS the green verdict.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  captureMemoryEval,
  floorFailures,
  flattenSummary,
  DEFAULT_FLOORS,
  DEFAULT_K,
  MEMORY_EVAL_CHECK_COMMAND,
} from '../lib/memory-eval.mjs'
import { isSafeCommand } from '../lib/predict.mjs'

const EMDASH = String.fromCharCode(0x2014)

const TAGS =
  `## area\n- crm ${EMDASH} customer relationship\n- auth ${EMDASH} authentication\n\n` +
  `## kind\n- reference ${EMDASH} a fact\n- decision ${EMDASH} a decision\n`

let dir: string
let corpusDir: string
let casesPath: string

function writeNote(file: string, fields: Record<string, string>) {
  const fm = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', 'body']
  writeFileSync(join(corpusDir, file), fm.join('\n') + '\n', 'utf8')
}

function writeCases(lines: object[]) {
  writeFileSync(casesPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-memory-eval-'))
  corpusDir = join(dir, 'memory')
  casesPath = join(dir, 'cases.jsonl')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(join(corpusDir, 'TAGS.md'), TAGS, 'utf8')
  writeFileSync(join(corpusDir, 'MEMORY.md'), '# index\n- a core line\n', 'utf8')
  writeNote('core-rule.md', { description: 'the always-loaded rule', kind: 'reference', tags: '[crm]', importance: '9' })
  writeNote('crm-detail.md', { description: 'a crm periphery note', kind: 'reference', tags: '[crm]', importance: '5' })
  writeNote('auth-detail.md', { description: 'an auth note a crm task never names', kind: 'reference', tags: '[auth]', importance: '3' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const opts = () => ({ corpusDir, casesPath, tagsPath: join(corpusDir, 'TAGS.md'), commit: 'c' })

describe('captureMemoryEval — the canon §8 report (Test 1)', () => {
  it('reports every §8 metric and a path-free, allowlist-safe check_command', () => {
    writeCases([
      { task: 'fix the crm handler', class: 'exact', expected_notes: ['core-rule.md', 'crm-detail.md'], critical_notes: ['core-rule.md'], forbidden_notes: [] },
      { task: 'read the crm rule', class: 'exact', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: ['auth-detail.md'] },
    ])

    const r = captureMemoryEval(opts())

    expect(r.metric).toBe('memory-eval')
    expect(r.k).toEqual([...DEFAULT_K])

    const s = r.summary
    expect(s.cases_total).toBe(2)
    for (const k of DEFAULT_K) {
      expect(typeof s.recall_at[k]).toBe('number')
      expect(typeof s.precision_at[k]).toBe('number')
    }
    expect(typeof s.mrr).toBe('number')
    expect(typeof s.ndcg).toBe('number')
    expect(s.critical_miss_rate).toBe(0)
    expect(s.superseded_selection_rate).toBe(0)
    expect(s.contradiction_exposure).toBe(0)
    expect(s.forbidden_hits).toBe(0)
    expect(s.abstain_pass).toBe(0)
    expect(s.abstain_fail).toBe(0)
    expect(s.corrupt_lines).toBe(0)
    expect(s.refused_cases).toBe(0)

    // recall@10 over a 3-note corpus: both cases retrieve everything they expect.
    expect(s.recall_at[10]).toBe(1)

    // The receipt contract — the SAME one baseline.mjs holds itself to.
    expect(r.check_command).toBe(MEMORY_EVAL_CHECK_COMMAND)
    expect(isSafeCommand(r.check_command)).toBe(true)
    expect(r.check_command).not.toMatch(/[\\/]{1}[A-Za-z]+[\\/]{1}.*\.jsonl/)
    expect(r.check_command.includes(corpusDir)).toBe(false)
    expect(r.check_command.includes(casesPath)).toBe(false)

    // the class axis the gold set is built on is carried through, not thrown away
    expect(r.by_class.map((c: any) => c.class)).toEqual(['exact'])
    expect(r.by_class[0].cases).toBe(2)
  })
})

describe('honest empties (Test 2)', () => {
  it('a set with no rankable question reports null, never a fabricated 0.0 or 1.0', () => {
    // Both cases name no expected note at all: there is nothing to rank.
    writeCases([
      { task: 'fix the crm handler', expected_notes: [], critical_notes: [], forbidden_notes: [] },
      { task: 'read the crm rule', expected_notes: [], critical_notes: [], forbidden_notes: [] },
    ])

    const r = captureMemoryEval(opts())
    expect(r.summary.cases_total).toBe(2)
    expect(r.summary.rankable_cases).toBe(0)
    for (const k of DEFAULT_K) {
      expect(r.summary.recall_at[k]).toBeNull()
      expect(r.summary.precision_at[k]).toBeNull()
    }
    expect(r.summary.mrr).toBeNull()
    expect(r.summary.ndcg).toBeNull()
  })

  it('zero cases is an honest empty report, not a throw and not a zero', () => {
    writeFileSync(casesPath, '', 'utf8')
    const r = captureMemoryEval(opts())
    expect(r.summary.cases_total).toBe(0)
    expect(r.summary.critical_miss_rate).toBeNull()
    expect(r.summary.superseded_selection_rate).toBeNull()
    expect(r.summary.contradiction_exposure).toBeNull()
    expect(r.summary.mrr).toBeNull()
    expect(r.summary.forbidden_hits).toBe(0) // a COUNT of nothing is honestly 0
    expect(r.by_class).toEqual([])
  })
})

describe('rank is the real pack order, and it is deterministic (Test 3)', () => {
  it('MRR and nDCG are computed over the ORDER the selection produced', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['auth-detail.md'], critical_notes: [], forbidden_notes: [] }])

    // A compile double that fixes the pack ORDER — the one thing the rank metrics read.
    const compile = () => ({
      members: [
        { type: 'note', id: 'core-rule.md', sub: 'core' },
        { type: 'note', id: 'crm-detail.md', sub: 'periphery' },
        { type: 'note', id: 'auth-detail.md', sub: 'periphery' },
      ],
    })

    const r = captureMemoryEval({ ...opts(), compile })
    // the single relevant note arrived third -> reciprocal rank 1/3
    expect(r.summary.mrr).toBeCloseTo(1 / 3, 4)
    // nDCG over the same order: gain at rank 3 / ideal gain at rank 1
    expect(r.summary.ndcg).toBeCloseTo(1 / Math.log2(4), 4)
    // recall@3 sees it, recall@... at a shorter cutoff does not
    expect(r.summary.recall_at[3]).toBe(1)
    expect(captureMemoryEval({ ...opts(), compile, k: [2] }).summary.recall_at[2]).toBe(0)
  })

  it('two runs over the same inputs produce identical report bytes', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['core-rule.md', 'crm-detail.md'], critical_notes: [], forbidden_notes: [] }])
    const a = captureMemoryEval({ ...opts(), now: '2026-08-03T00:00:00Z' })
    const b = captureMemoryEval({ ...opts(), now: '2026-08-03T00:00:00Z' })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/) // no clock in the bytes
  })
})

describe('retired and contradictory delivery (Test 4)', () => {
  it('a delivered superseded record raises superseded_selection_rate', () => {
    writeNote('retired-rule.md', {
      description: 'the rule that was replaced',
      kind: 'reference',
      tags: '[crm]',
      importance: '5',
      status: 'superseded',
    })
    writeCases([{ task: 'fix the crm handler', expected_notes: ['crm-detail.md'], critical_notes: [], forbidden_notes: [] }])

    // The live read path filters a superseded record out (that is the 10-01 landing),
    // so the violation is STAGED with a compile double: the metric must be able to see
    // it the day some future retriever stops filtering.
    const clean = captureMemoryEval(opts())
    expect(clean.summary.superseded_selection_rate).toBe(0)

    const leaking = captureMemoryEval({
      ...opts(),
      compile: () => ({
        members: [
          { type: 'note', id: 'crm-detail.md', sub: 'periphery' },
          { type: 'note', id: 'retired-rule.md', sub: 'periphery' },
        ],
      }),
    })
    expect(leaking.summary.superseded_selection_rate).toBe(1)
    expect(leaking.superseded_selections).toEqual([{ case: 'fix the crm handler', notes: ['retired-rule.md'] }])
  })

  it('both halves of a declared contradiction in one pack raise contradiction_exposure', () => {
    writeNote('queue-yes.md', { description: 'always use the crm retry queue for failed deliveries', kind: 'decision', tags: '[crm]', importance: '6' })
    writeNote('queue-no.md', { description: 'never use the crm retry queue for failed deliveries', kind: 'decision', tags: '[crm]', importance: '6' })
    writeCases([{ task: 'fix the crm handler', expected_notes: ['crm-detail.md'], critical_notes: [], forbidden_notes: [] }])

    const r = captureMemoryEval(opts())
    expect(r.summary.contradiction_exposure).toBe(1)
    expect(r.contradiction_exposures).toEqual([
      { case: 'fix the crm handler', pairs: [['queue-no.md', 'queue-yes.md']] },
    ])
  })
})

describe('floors — the deterministic red/green verdict (Test 5)', () => {
  it('floorFailures names every violated floor and nothing else', () => {
    const green = {
      critical_miss_rate: 0,
      forbidden_hits: 0,
      superseded_selection_rate: 0,
      corrupt_lines: 0,
      refused_cases: 0,
    }
    expect(floorFailures(green)).toEqual([])

    const red = { ...green, forbidden_hits: 6, critical_miss_rate: 0.25 }
    const failures = floorFailures(red)
    expect(failures.map((f: any) => f.metric)).toEqual(['critical_miss_rate', 'forbidden_hits'])
    expect(failures[1]).toEqual({ metric: 'forbidden_hits', value: 6, comparator: '<=', threshold: 0 })
  })

  it('an honest empty cannot fail a floor — an unasked question has no verdict', () => {
    expect(floorFailures({ critical_miss_rate: null, forbidden_hits: 0, superseded_selection_rate: null, corrupt_lines: 0, refused_cases: 0 })).toEqual([])
  })

  it('the floors are frozen, and the report carries both the floors and their verdict', () => {
    expect(Object.isFrozen(DEFAULT_FLOORS)).toBe(true)
    writeCases([{ task: 'fix the crm handler', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: ['crm-detail.md'] }])
    const r = captureMemoryEval(opts())
    expect(r.floors).toEqual(DEFAULT_FLOORS)
    // crm-detail.md is forbidden by the case and loads anyway -> the floor is red
    expect(r.summary.forbidden_hits).toBe(1)
    expect(r.floor_failures.map((f: any) => f.metric)).toEqual(['forbidden_hits'])
  })

  it('flattenSummary is the ONE list of stat names — nested metrics get a dotted key', () => {
    const flat = flattenSummary({ cases_total: 3, recall_at: { 3: 0.5, 10: 1 }, mrr: null })
    expect(flat).toEqual({ cases_total: 3, 'recall_at.3': 0.5, 'recall_at.10': 1, mrr: null })
  })
})
