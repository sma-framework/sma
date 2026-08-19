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
 *   - Test 6 (the verb): `eval memory --stat <name>` prints ONE bare value and exits 0;
 *     an unknown stat prints the legal names — derived from the summary itself — and
 *     exits 1.
 *   - Test 7 (the A/B, Phase 10 Plan 09): the SAME gold set scored twice — default path
 *     vs the named experiment — reported as deltas in percentage points; deterministic
 *     on a fixture; a layer that changes nothing reports zero rather than noise; and the
 *     report names NO winner, because the stopping rule is applied by a person.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  captureMemoryEval,
  captureMemoryExperiment,
  floorFailures,
  flattenSummary,
  DEFAULT_FLOORS,
  DEFAULT_K,
  EXPERIMENTS,
  MEMORY_EVAL_CHECK_COMMAND,
  MEMORY_EXPERIMENT_CHECK_COMMAND,
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

describe('the verb — sma eval memory (Test 6)', () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')

  /** A whole throwaway project: .sma root, a corpus, a gold-cases file. */
  function seedProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'sma-eval-cli-'))
    const memory = join(root, '.claude', 'memory')
    mkdirSync(join(root, '.sma'), { recursive: true })
    mkdirSync(memory, { recursive: true })
    writeFileSync(join(memory, 'TAGS.md'), TAGS, 'utf8')
    writeFileSync(join(memory, 'MEMORY.md'), '# index\n- a core line\n', 'utf8')
    writeFileSync(
      join(memory, 'core-rule.md'),
      '---\ndescription: the always-loaded rule\nkind: reference\ntags: [crm]\nimportance: 9\n---\nbody\n',
      'utf8',
    )
    writeFileSync(
      join(memory, 'gold-cases.jsonl'),
      [
        JSON.stringify({ task: 'fix the crm handler', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] }),
        JSON.stringify({ task: 'read the crm rule', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] }),
      ].join('\n') + '\n',
      'utf8',
    )
    return root
  }

  function runCli(root: string, args: string[]): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execFileSync('node', [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, SMA_ROOT_OVERRIDE: join(root, '.sma') },
      })
      return { stdout, stderr: '', status: 0 }
    } catch (err: any) {
      return {
        stdout: (err.stdout ?? '').toString(),
        stderr: (err.stderr ?? '').toString(),
        status: typeof err.status === 'number' ? err.status : 1,
      }
    }
  }

  let root: string
  beforeEach(() => {
    root = seedProject()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('--stat prints ONE bare value as the last line and exits 0', () => {
    const res = runCli(root, ['eval', 'memory', '--stat', 'cases_total'])
    expect(res.status).toBe(0)
    const last = res.stdout.trim().split('\n').pop() as string
    expect(last).toBe('2')
    expect(Number.isInteger(Number(last))).toBe(true)

    // a nested metric is reachable by its dotted name, the same way it is listed
    const nested = runCli(root, ['eval', 'memory', '--stat', 'recall_at.10'])
    expect(nested.status).toBe(0)
    expect(Number(nested.stdout.trim())).toBe(1)
  })

  it('an unknown --stat prints the legal names and exits 1', () => {
    const res = runCli(root, ['eval', 'memory', '--stat', 'no-such-metric'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('cases_total')
    expect(res.stderr).toContain('critical_miss_rate')
    expect(res.stderr).toContain('recall_at.10')
  })

  it('an unknown subcommand is refused with the one that exists', () => {
    const res = runCli(root, ['eval', 'workflow'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('memory')
  })

  it('--experiment names the arms it knows and refuses the ones it does not', () => {
    const bogus = runCli(root, ['eval', 'memory', '--experiment', 'dense'])
    expect(bogus.status).toBe(1)
    expect(bogus.stderr).toContain('lexical')

    // the A/B arm answers the pre-registered stat by name, as ONE bare value
    const p1 = runCli(root, ['eval', 'memory', '--experiment', 'lexical', '--stat', 'critical_recall_delta_pct'])
    expect(p1.status).toBe(0)
    expect(Number.isFinite(Number(p1.stdout.trim()))).toBe(true)
    const p2 = runCli(root, ['eval', 'memory', '--experiment', 'lexical', '--stat', 'precision_delta_pct'])
    expect(p2.status).toBe(0)
    expect(Number.isFinite(Number(p2.stdout.trim()))).toBe(true)
  })

  it('the full report carries the floors, their verdict, and a path-free check_command', () => {
    const res = runCli(root, ['eval', 'memory', '--json'])
    const report = JSON.parse(res.stdout.trim().split('\n').pop() as string)
    expect(report.metric).toBe('memory-eval')
    expect(report.summary.cases_total).toBe(2)
    expect(report.check_command).toBe(MEMORY_EVAL_CHECK_COMMAND)
    expect(report.check_command.includes(root)).toBe(false)
    // this seeded corpus violates nothing, so the exit code is the green verdict
    expect(report.floor_failures).toEqual([])
    expect(report.floor_verdict).toBe('met')
    expect(res.status).toBe(0)
  })

  it('a set with no cases prints «no data» instead of a floors verdict, and exits non-zero', () => {
    writeFileSync(join(root, '.claude', 'memory', 'gold-cases.jsonl'), '', 'utf8')

    const res = runCli(root, ['eval', 'memory'])
    // the printed claim that everything is fine must be GONE — zero cases is
    // ignorance, and a gate that goes green on ignorance is not a gate
    expect(res.stdout).not.toContain('все полы соблюдены')
    expect(res.stdout).toContain('нет данных')
    expect(res.status).not.toBe(0)

    const asJson = runCli(root, ['eval', 'memory', '--json'])
    const report = JSON.parse(asJson.stdout.trim().split('\n').pop() as string)
    // the machine reader tells an unasked question from a clean run by ONE field
    expect(report.floor_verdict).toBe('no-data')
    expect(report.floor_failures).toEqual([])
  })

  it('an empty A/B is not a recorded comparison: it says so and exits non-zero', () => {
    writeFileSync(join(root, '.claude', 'memory', 'gold-cases.jsonl'), '', 'utf8')

    const res = runCli(root, ['eval', 'memory', '--experiment', 'lexical'])
    expect(res.stdout).not.toContain('полы экспериментальной руки соблюдены')
    expect(res.stdout).toContain('нет данных')
    expect(res.status).not.toBe(0)
  })
})

// ── the A/B (Test 7) ─────────────────────────────────────────────────────────

/**
 * A lexical-layer double, so the A/B is testable on a machine whose Node has no
 * `node:sqlite` and with no index on disk. `finds` is what the lexical arm returns for
 * every task — enough to move an order, which is all the arithmetic under test needs.
 */
function lexicalDouble(finds: string[], stale = 0) {
  return {
    indexStatus: () => ({ engine: 'fts5', reason: '', summary: { stale, exists: 1, indexed: 3, corpus_notes: 3, visible_notes: 3, engine_available: 1 } }),
    queryExact: () => ({ results: [] }),
    queryLexical: () => ({ results: finds.map((id, i) => ({ id, score: 10 - i, rank: i + 1 })) }),
  }
}

describe('captureMemoryExperiment — two arms, one set (Test 7)', () => {
  it('reports both summaries and the deltas, deterministically, and names no winner', () => {
    writeCases([
      { task: 'fix the crm handler', class: 'exact', expected_notes: ['crm-detail.md'], critical_notes: ['crm-detail.md'], forbidden_notes: [] },
      { task: 'read the crm rule', class: 'exact', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] },
    ])

    const args = { ...opts(), indexPath: join(dir, 'idx.sqlite'), lexical: lexicalDouble(['auth-detail.md']) }
    const r = captureMemoryExperiment(args)

    expect(r.metric).toBe('memory-eval-experiment')
    expect(r.experiment).toBe('lexical')
    expect(EXPERIMENTS).toContain('lexical')
    expect(r.check_command).toBe(MEMORY_EXPERIMENT_CHECK_COMMAND)
    expect(isSafeCommand(r.check_command)).toBe(true)
    expect(r.check_command.includes(dir)).toBe(false)

    // BOTH arms are reported in full — a delta without its two ends cannot be audited
    expect(r.arms.control.cases_total).toBe(2)
    expect(r.arms.experiment.cases_total).toBe(2)
    // the control arm is the default path: it must equal a plain run of the measurer
    expect(r.arms.control).toEqual(captureMemoryEval(opts()).summary)

    // every pre-registered delta name is present and numeric
    for (const name of ['critical_recall_delta_pct', 'precision_delta_pct', 'recall_delta_pct', 'forbidden_delta']) {
      expect(Object.prototype.hasOwnProperty.call(r.summary, name)).toBe(true)
      expect(Number.isFinite(Number((r.summary as Record<string, number>)[name]))).toBe(true)
    }

    // the layer DID something: it delivered a note the facet path never chose
    expect(r.summary.notes_delivered_delta).toBeGreaterThan(0)
    expect(r.summary.pack_tokens_experiment).toBeGreaterThan(r.summary.pack_tokens_control)

    // no verdict field anywhere — the stopping rule is a person's to apply
    expect(Object.keys(r)).not.toContain('verdict')
    expect(Object.keys(r.summary)).not.toContain('accepted')

    // deterministic: the same inputs give byte-identical bytes
    expect(JSON.stringify(captureMemoryExperiment(args))).toBe(JSON.stringify(r))
  })

  it('an arm that cannot run honestly degrades to the control, and the deltas are zero — not noise', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['crm-detail.md'], critical_notes: [], forbidden_notes: [] }])

    // a STALE index: the layer refuses to rank and the compiler falls back to the default
    const r = captureMemoryExperiment({ ...opts(), indexPath: join(dir, 'idx.sqlite'), lexical: lexicalDouble(['auth-detail.md'], 1) })

    expect(r.arms.experiment).toEqual(r.arms.control)
    expect(r.summary.critical_recall_delta_pct).toBe(0)
    expect(r.summary.precision_delta_pct).toBe(0)
    expect(r.summary.recall_delta_pct).toBe(0)
    expect(r.summary.forbidden_delta).toBe(0)
    expect(r.summary.pack_tokens_delta_pct).toBe(0)
  })
})

// ── a verdict needs data ─────────────────────────────────────────────────────

/**
 * ZERO CASES IS NOT A PASS. The floors answer a question the gold set asks; a set that
 * asks nothing gets no answer, and reporting one is the same fabrication the honest
 * empties law already forbids for the ranking metrics. The distinction is carried by ONE
 * named field, so a reader — human or machine — never has to infer it from an empty list.
 */
describe('the floors verdict exists only when the set asked something', () => {
  it('zero cases: the report says «no data», and the failure list stays empty', () => {
    writeFileSync(casesPath, '', 'utf8')

    const r = captureMemoryEval(opts())
    expect(r.summary.cases_total).toBe(0)
    expect(r.floor_verdict).toBe('no-data')
    // an empty list of failures is TRUE here and yet means nothing — which is exactly
    // why it cannot be the whole verdict on its own
    expect(r.floor_failures).toEqual([])
  })

  it('a non-empty set with clean floors keeps the green verdict it always had', () => {
    writeCases([{ task: 'read the crm rule', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] }])

    const r = captureMemoryEval(opts())
    expect(r.summary.cases_total).toBe(1)
    expect(r.floor_failures).toEqual([])
    expect(r.floor_verdict).toBe('met')
  })

  it('a non-empty set with a red floor still reports the violation', () => {
    writeCases([{ task: 'read the crm rule', expected_notes: ['core-rule.md'], critical_notes: ['auth-detail.md'], forbidden_notes: [] }])

    const r = captureMemoryEval(opts())
    expect(r.floor_verdict).toBe('violated')
    expect(r.floor_failures.map((f: any) => f.metric)).toContain('critical_miss_rate')
  })

  it('the A/B carries the same distinction — an empty comparison renders no verdict', () => {
    writeFileSync(casesPath, '', 'utf8')
    const empty = captureMemoryExperiment({ ...opts(), indexPath: join(dir, 'idx.sqlite'), lexical: lexicalDouble([]) })
    expect(empty.floor_verdict).toBe('no-data')

    writeCases([{ task: 'read the crm rule', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] }])
    const measured = captureMemoryExperiment({ ...opts(), indexPath: join(dir, 'idx.sqlite'), lexical: lexicalDouble(['auth-detail.md']) })
    expect(measured.floor_verdict).toBe('met')
  })
})
