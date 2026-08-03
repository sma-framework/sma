/**
 * Tests for scripts/sma/lib/north-star.mjs — the NORTH-STAR MEASURER.
 *
 * One number the whole layer is answerable to: what does ONE VERIFIED CORRECT RESULT
 * cost — in tokens, in compute, in wall-clock, and in the minutes a human spent. The
 * module composes that number out of the measurers that already exist and invents no
 * second one; where a component has no measurer at all it reports `null` and says so.
 *
 *   - Test 1 (report shape + receipt contract): the four named components, the verified
 *     result count, the per-result cost, a measured|partial status, and a path-free,
 *     allowlist-safe check_command.
 *   - Test 2 (the honest hole): human minutes are measured by NOTHING today. The
 *     component is `null`, the status degrades to `partial`, the formula falls back to
 *     the measurable terms — and a fabricated 0 is never substituted, because a 0 there
 *     would read as «humans spend no time», which is the opposite of the truth.
 *   - Test 3 (guardrail panel): the recorded receipts and the §8 summary reduce to rows
 *     of {metric, value, source_command}; a guardrail with no recorded receipt is a row
 *     with status `missing` and a command that would produce it — never a number.
 *   - Test 4 (the feature gate): five elements or no entry. A declaration missing any
 *     one of them is refused BY NAME, and a prediction whose threshold is not a number
 *     is refused too — an unfalsifiable prediction is the gate's whole failure mode.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  captureNorthStar,
  guardrailPanel,
  evalFeatureGate,
  flattenSummary,
  GATE_ELEMENTS,
  HUMAN_MINUTES_SOURCE,
  NORTH_STAR_CHECK_COMMAND,
  RESULTS_HORIZON,
} from '../lib/north-star.mjs'
import { captureMemoryEval, MEMORY_EVAL_CHECK_COMMAND } from '../lib/memory-eval.mjs'
import { isSafeCommand } from '../lib/predict.mjs'
import { receiptIdFor, BASELINE_METRICS } from '../lib/baseline.mjs'

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-north-star-'))
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

/** A gold set of three cases: two that the loader answers, one it fails on purpose. */
function writeCases(lines: object[]) {
  writeFileSync(casesPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

/** The REAL §8 report — the verified-result count is read from it, never re-derived. */
function realEvalReport() {
  writeCases([
    { task: 'fix the crm handler', class: 'exact', expected_notes: ['core-rule.md'], critical_notes: ['core-rule.md'], forbidden_notes: [] },
    { task: 'read the crm rule', class: 'exact', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] },
    // this one is a failure BY CONSTRUCTION: the note it forbids loads anyway
    { task: 'audit the crm rule', class: 'adversarial', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: ['crm-detail.md'] },
  ])
  return captureMemoryEval({ corpusDir, casesPath, tagsPath: join(corpusDir, 'TAGS.md'), commit: 'c' })
}

/** A spend book in the shape buildBook returns — injected, never discovered. */
function book(now: number) {
  return {
    totals: { usd: 3, inputTokens: 800, outputTokens: 150, cacheCreationTokens: 30, cacheReadTokens: 20, events: 2 },
    events: [
      { ts: new Date(now - 60_000).toISOString(), usd: 2, model: 'm', sessionId: 's' },
      { ts: new Date(now - 120_000).toISOString(), usd: 1, model: 'm', sessionId: 's' },
    ],
    pricingVersion: 'test-pricing',
  }
}

describe('captureNorthStar — cost per verified correct result (Test 1)', () => {
  it('reports the four components, the verified count, the per-result cost and a safe check_command', () => {
    const now = Date.parse('2026-08-03T12:00:00Z')
    const evalReport = realEvalReport()

    const r = captureNorthStar({
      evalReport,
      book: book(now),
      now,
      windowHours: 5,
      wallClockMs: 4200,
    })

    expect(r.metric).toBe('north-star')

    // the four components, each carrying WHERE its number came from
    expect(Object.keys(r.components).sort()).toEqual(['compute', 'human_minutes', 'tokens', 'wall_clock_ms'])
    for (const name of Object.keys(r.components)) {
      expect(typeof r.components[name].source).toBe('string')
      expect(r.components[name].source.length).toBeGreaterThan(0)
      expect(['measured', 'unmeasured']).toContain(r.components[name].status)
    }

    // tokens and compute come from the spend book; wall-clock from the timed run
    expect(r.components.tokens.value).toBe(1000) // 800 + 150 + 30 + 20
    expect(r.components.tokens.status).toBe('measured')
    expect(r.components.compute.value).toBe(3) // both events inside the 5h window
    expect(r.components.compute.unit).toBe('usd')
    expect(r.components.wall_clock_ms.value).toBe(4200)

    // two of the three gold cases came back correct; the third violated a forbidden note
    expect(r.verified_results_count).toBe(2)
    expect(typeof r.verified_results_source).toBe('string')

    // the per-result cost divides only the measurable terms
    expect(r.cost_per_verified_result).not.toBeNull()
    expect(r.cost_per_verified_result.tokens).toBe(500)
    expect(r.cost_per_verified_result.compute_usd).toBe(1.5)
    expect(r.cost_per_verified_result.wall_clock_ms).toBe(2100)

    // ... and never claims a number for the term nothing measures
    expect(r.cost_per_verified_result.human_minutes).toBeNull()
    expect(r.status).toBe('partial')

    // the receipt contract — the SAME one baseline.mjs and the §8 measurer hold
    expect(r.check_command).toBe(NORTH_STAR_CHECK_COMMAND)
    expect(isSafeCommand(r.check_command)).toBe(true)
    expect(r.check_command.includes(corpusDir)).toBe(false)
    expect(r.check_command.includes(dir)).toBe(false)
  })

  it('status is measured only when all four components carry a number', () => {
    const now = Date.parse('2026-08-03T12:00:00Z')
    const r = captureNorthStar({
      evalReport: realEvalReport(),
      book: book(now),
      now,
      wallClockMs: 4200,
      humanMinutes: 12,
    })
    expect(r.status).toBe('measured')
    expect(r.unmeasured_components).toEqual([])
    expect(r.components.human_minutes.value).toBe(12)
    expect(r.components.human_minutes.status).toBe('measured')
    expect(r.cost_per_verified_result.human_minutes).toBe(6)
  })

  it('no verified-result count is an honest null answer, not a division by nothing', () => {
    const now = Date.parse('2026-08-03T12:00:00Z')
    const r = captureNorthStar({ book: book(now), now, wallClockMs: 100 })
    expect(r.verified_results_count).toBeNull()
    expect(r.cost_per_verified_result).toBeNull()
    expect(r.status).toBe('partial')
    // the stat table keeps its names even when there is no answer to put in them
    expect(flattenSummary(r.summary)).toHaveProperty('cost_per_verified_result.tokens', null)
  })
})

describe('the honest hole — human minutes (Test 2)', () => {
  it('with no source, human minutes are null and the status degrades to partial', () => {
    const now = Date.parse('2026-08-03T12:00:00Z')
    const r = captureNorthStar({ evalReport: realEvalReport(), book: book(now), now, wallClockMs: 4200 })

    expect(r.components.human_minutes.value).toBeNull()
    expect(r.components.human_minutes.status).toBe('unmeasured')
    // the component names WHERE the future measurement will come from
    expect(r.components.human_minutes.source).toBe(HUMAN_MINUTES_SOURCE)
    expect(r.components.human_minutes.source.length).toBeGreaterThan(20)

    expect(r.status).toBe('partial')
    expect(r.unmeasured_components).toEqual(['human_minutes'])

    // the formula degrades to the measurable terms — and states that it did
    expect(r.cost_per_verified_result.tokens).toBe(500)
    expect(r.cost_per_verified_result.human_minutes).toBeNull()
    expect(r.partial_reason).toContain('human_minutes')
  })

  it('a 0 is NEVER substituted for the unmeasured component, anywhere in the report', () => {
    const now = Date.parse('2026-08-03T12:00:00Z')
    const r = captureNorthStar({ evalReport: realEvalReport(), book: book(now), now, wallClockMs: 4200 })
    expect(r.components.human_minutes.value).not.toBe(0)
    expect(r.cost_per_verified_result.human_minutes).not.toBe(0)
    expect(r.summary.human_minutes).toBeNull()
    expect(flattenSummary(r.summary)['cost_per_verified_result.human_minutes']).toBeNull()
  })

  it('a component with no source at all is unmeasured, not zero', () => {
    // no book: neither the token volume nor the compute price has a measurer here
    const r = captureNorthStar({ evalReport: realEvalReport(), now: Date.parse('2026-08-03T12:00:00Z') })
    expect(r.components.tokens.value).toBeNull()
    expect(r.components.compute.value).toBeNull()
    expect(r.components.wall_clock_ms.value).toBeNull()
    expect(r.unmeasured_components).toEqual(['compute', 'human_minutes', 'tokens', 'wall_clock_ms'])
    // there IS a verified count, so the answer object exists — with nothing but nulls in it
    expect(r.verified_results_count).toBe(2)
    expect(r.cost_per_verified_result).toEqual({
      tokens: null,
      wall_clock_ms: null,
      compute_usd: null,
      human_minutes: null,
    })
  })

  it('an EMPTY spend book is an absence, not a measured zero', () => {
    // buildBook fails open: an undiscoverable logs directory returns an empty book
    // rather than throwing, so «no logs» arrives looking exactly like a thrifty
    // session. Reporting 0 tokens and $0 here would be the fabrication this whole
    // module exists to refuse — found on the first live run of the verb.
    const empty = {
      totals: { usd: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, events: 0 },
      events: [],
      pricingVersion: 'test-pricing',
    }
    const r = captureNorthStar({ evalReport: realEvalReport(), book: empty, now: Date.parse('2026-08-03T12:00:00Z'), wallClockMs: 7 })
    expect(r.components.tokens.value).toBeNull()
    expect(r.components.tokens.status).toBe('unmeasured')
    expect(r.components.compute.value).toBeNull()
    expect(r.components.compute.status).toBe('unmeasured')
    // ... while a book that HAS events and an empty WINDOW is a genuine zero
    const now = Date.parse('2026-08-03T12:00:00Z')
    const stale = { ...book(now), events: [{ ts: new Date(now - 100 * 3600 * 1000).toISOString(), usd: 9, model: 'm', sessionId: 's' }] }
    const windowed = captureNorthStar({ evalReport: realEvalReport(), book: stale, now, windowHours: 5, wallClockMs: 7 })
    expect(windowed.components.compute.value).toBe(0)
    expect(windowed.components.compute.status).toBe('measured')
  })

  it('the static self-cost stands in for the token volume when no spend book exists', () => {
    const claudeMd = join(dir, 'CLAUDE.md')
    writeFileSync(claudeMd, '# project\nsome rules\n', 'utf8')
    const r = captureNorthStar({
      evalReport: realEvalReport(),
      selfCostPaths: { memoryMd: join(corpusDir, 'MEMORY.md'), claudeMd },
      now: Date.parse('2026-08-03T12:00:00Z'),
    })
    expect(r.components.tokens.value).toBeGreaterThan(0)
    expect(r.components.tokens.status).toBe('measured')
    // and it says WHICH question it answered, because it is not the same question
    expect(r.components.tokens.basis).toBe('static-injection')
  })
})

describe('the accounting horizons are declared, not blurred', () => {
  it('a cost drawn from a different period than the divisor is reported as such', () => {
    const now = Date.parse('2026-08-03T12:00:00Z')
    // the book's token totals are ALL-TIME (its events carry no token counts, so the
    // rolling window cannot bound them) while the divisor is one benchmark run
    const r = captureNorthStar({ evalReport: realEvalReport(), book: book(now), now, windowHours: 5, wallClockMs: 4200 })

    expect(r.results_horizon).toBe(RESULTS_HORIZON)
    expect(r.horizon_aligned).toBe(false)
    expect(r.horizon_caveat).toContain('tokens')
    expect(r.horizon_caveat).toContain('compute')
    expect(r.horizons.wall_clock_ms).toBe(RESULTS_HORIZON)
    expect(r.summary.horizon_aligned).toBe(false)

    // the number is still produced — the caveat is disclosure, not suppression
    expect(r.cost_per_verified_result.tokens).toBe(500)
  })

  it('when every measured component shares the divisor period, there is no caveat', () => {
    const r = captureNorthStar({
      evalReport: realEvalReport(),
      now: Date.parse('2026-08-03T12:00:00Z'),
      wallClockMs: 4200,
      humanMinutes: 6,
    })
    expect(r.horizon_aligned).toBe(true)
    expect(r.horizon_caveat).toBeNull()
  })
})

describe('guardrailPanel — the receipts in one place (Test 3)', () => {
  it('reduces recorded receipts and the §8 summary to rows with a reproduction command', () => {
    const evalReport = realEvalReport()
    const receipts = [
      {
        id: receiptIdFor('retrieval'),
        assertion: 'the retrieval-recall baseline re-runs',
        check_command: 'node scripts/sma/cli.mjs baseline retrieval',
        expected_sha256: 'a'.repeat(64),
        expected_exit: 0,
      },
    ]

    const panel = guardrailPanel({ receipts, evalReport })

    expect(panel.metric).toBe('guardrail-panel')
    expect(Array.isArray(panel.rows)).toBe(true)
    for (const row of panel.rows) {
      expect(typeof row.metric).toBe('string')
      expect(row).toHaveProperty('value')
      expect(typeof row.source_command).toBe('string')
      expect(row.source_command.length).toBeGreaterThan(0)
      expect(isSafeCommand(row.source_command)).toBe(true)
    }

    // the recorded receipt is a recorded row, carrying the command that re-runs it
    const recorded = panel.rows.find((r: any) => r.metric === receiptIdFor('retrieval'))
    expect(recorded.status).toBe('recorded')
    expect(recorded.source_command).toBe('node scripts/sma/cli.mjs baseline retrieval')
    expect(String(recorded.value)).toContain('aaaaaaaa')

    // the §8 guardrails come from the eval summary, with ITS command beside them
    const forbidden = panel.rows.find((r: any) => r.metric === 'forbidden_hits')
    expect(forbidden.status).toBe('measured')
    expect(forbidden.value).toBe(evalReport.summary.forbidden_hits)
    expect(forbidden.source_command).toBe(MEMORY_EVAL_CHECK_COMMAND)
  })

  it('a guardrail with no recorded receipt is a MISSING row, never an invented number', () => {
    const panel = guardrailPanel({ receipts: [], evalReport: null })

    // every baseline metric is represented, and every one of them is honestly missing
    for (const metric of BASELINE_METRICS) {
      const row = panel.rows.find((r: any) => r.metric === receiptIdFor(metric))
      expect(row).toBeDefined()
      expect(row.status).toBe('missing')
      expect(row.value).toBeNull()
      // the command it names is the one that would PRODUCE the missing receipt
      expect(row.source_command).toContain(metric)
      expect(isSafeCommand(row.source_command)).toBe(true)
    }

    // the §8 rows are missing too — and say so with the command that fills them
    const forbidden = panel.rows.find((r: any) => r.metric === 'forbidden_hits')
    expect(forbidden.status).toBe('missing')
    expect(forbidden.value).toBeNull()
    expect(forbidden.source_command).toBe(MEMORY_EVAL_CHECK_COMMAND)

    expect(panel.missing).toBe(panel.rows.length)
  })

  it('the north-star report carries the panel — one report, not two commands', () => {
    const now = Date.parse('2026-08-03T12:00:00Z')
    const r = captureNorthStar({ evalReport: realEvalReport(), book: book(now), now, wallClockMs: 10 })
    expect(r.guardrail.metric).toBe('guardrail-panel')
    expect(r.guardrail.rows.length).toBeGreaterThan(0)
    expect(r.summary.guardrail_missing).toBe(r.guardrail.missing)
  })
})

describe('evalFeatureGate — five elements or no entry (Test 4)', () => {
  const complete = () => ({
    feature: 'a second retrieval layer behind the default path',
    failure_class: 'the pack orders the needed record below the reader position',
    baseline_ref: 'baseline-retrieval receipt recorded on the current corpus',
    prediction: {
      metric: 'ndcg',
      comparator: '>=',
      threshold: 0.55,
      check_command: 'node scripts/sma/cli.mjs eval memory --stat ndcg',
    },
    acceptance: 'the floors stay green and precision at three does not fall',
    rollback: 'the layer is behind a flag that is off by default; turning it off restores the previous path byte for byte',
  })

  it('a declaration carrying all five elements passes', () => {
    const res = evalFeatureGate(complete())
    expect(res.ok).toBe(true)
    expect(res.missing).toEqual([])
    expect(res.errors).toEqual([])
    expect(GATE_ELEMENTS).toEqual(['failure_class', 'baseline_ref', 'prediction', 'acceptance', 'rollback'])
  })

  it('every missing element is refused BY NAME, one at a time', () => {
    for (const element of GATE_ELEMENTS) {
      const decl: any = complete()
      delete decl[element]
      const res = evalFeatureGate(decl)
      expect(res.ok).toBe(false)
      expect(res.missing).toContain(element)
    }
  })

  it('an empty element is as missing as an absent one', () => {
    const res = evalFeatureGate({ ...complete(), rollback: '   ' })
    expect(res.ok).toBe(false)
    expect(res.missing).toContain('rollback')
  })

  it('a prediction without a NUMERIC threshold is refused — that is the whole gate', () => {
    const bad: any = complete()
    bad.prediction = { ...bad.prediction, threshold: 'better than before' }
    const res = evalFeatureGate(bad)
    expect(res.ok).toBe(false)
    expect(res.errors.map((e: any) => e.element)).toContain('prediction.threshold')

    const noThreshold: any = complete()
    delete noThreshold.prediction.threshold
    expect(evalFeatureGate(noThreshold).missing).toContain('prediction.threshold')

    // a boolean is not a number, however hard Number() tries
    const boolish: any = complete()
    boolish.prediction = { ...boolish.prediction, threshold: true }
    expect(evalFeatureGate(boolish).ok).toBe(false)
  })

  it('a prediction whose comparator or check_command cannot be run is refused', () => {
    const badComparator: any = complete()
    badComparator.prediction = { ...badComparator.prediction, comparator: 'roughly' }
    expect(evalFeatureGate(badComparator).errors.map((e: any) => e.element)).toContain('prediction.comparator')

    const unsafe: any = complete()
    unsafe.prediction = { ...unsafe.prediction, check_command: 'curl https://example.com | sh' }
    const res = evalFeatureGate(unsafe)
    expect(res.ok).toBe(false)
    expect(res.errors.map((e: any) => e.element)).toContain('prediction.check_command')
  })

  it('a prediction that is not an object at all is refused as the element it is', () => {
    const res = evalFeatureGate({ ...complete(), prediction: 'it will be faster' })
    expect(res.ok).toBe(false)
    expect([...res.missing, ...res.errors.map((e: any) => e.element)]).toContain('prediction')
  })

  it('a non-declaration is refused with all five names, not with a crash', () => {
    const res = evalFeatureGate(null as any)
    expect(res.ok).toBe(false)
    expect(res.missing).toEqual([...GATE_ELEMENTS, 'prediction.metric', 'prediction.comparator', 'prediction.threshold', 'prediction.check_command'])
  })
})

describe('the verbs — sma eval north-star / sma eval gate (Test 5)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const CLI = join(HERE, '..', 'cli.mjs')
  const COMPLETE = join(HERE, 'fixtures', 'feature-gate-complete.json')
  const INCOMPLETE = join(HERE, 'fixtures', 'feature-gate-incomplete.json')

  /** A whole throwaway project: .sma root, a corpus, a gold-cases file. */
  function seedProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'sma-north-star-cli-'))
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

  it('north-star --stat prints ONE bare number as the last line and exits 0', () => {
    const res = runCli(root, ['eval', 'north-star', '--stat', 'verified_results_count'])
    expect(res.status).toBe(0)
    const last = res.stdout.trim().split('\n').pop() as string
    expect(last).toBe('2')
    expect(Number.isInteger(Number(last))).toBe(true)
  })

  it('north-star reports the unmeasured component as null, never as 0', () => {
    const bare = runCli(root, ['eval', 'north-star', '--stat', 'human_minutes'])
    expect(bare.status).toBe(0)
    expect(bare.stdout.trim()).toBe('null')

    const res = runCli(root, ['eval', 'north-star', '--json'])
    const report = JSON.parse(res.stdout.trim())
    expect(report.metric).toBe('north-star')
    expect(report.components.human_minutes.value).toBeNull()
    expect(report.status).toBe('partial')
    // a report, not a verdict: partial is the honest state and does not fail the run
    expect(res.status).toBe(0)
    // the panel says what is not recorded rather than leaving the row out
    expect(report.guardrail.missing).toBeGreaterThan(0)
    expect(report.check_command).toBe(NORTH_STAR_CHECK_COMMAND)
    expect(report.check_command.includes(root)).toBe(false)
  })

  it('an unknown --stat prints the legal names, taken from the report itself', () => {
    const res = runCli(root, ['eval', 'north-star', '--stat', 'no-such-thing'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('verified_results_count')
    expect(res.stderr).toContain('cost_per_verified_result.tokens')
  })

  it('gate passes the complete declaration and refuses the incomplete one BY NAME', () => {
    const ok = runCli(root, ['eval', 'gate', '--file', COMPLETE])
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('ndcg')

    const bad = runCli(root, ['eval', 'gate', '--file', INCOMPLETE])
    expect(bad.status).toBe(1)
    expect(bad.stdout).toContain('rollback')
    expect(bad.stdout).toContain('prediction.threshold')
  })

  it('gate without a file, and gate on an unreadable file, are refused with a reason', () => {
    const noFile = runCli(root, ['eval', 'gate'])
    expect(noFile.status).toBe(1)
    expect(noFile.stdout).toContain('--file')

    const missing = runCli(root, ['eval', 'gate', '--file', join(root, 'nope.json')])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('ENOENT')
  })

  it('an unknown eval subcommand names the three that exist', () => {
    const res = runCli(root, ['eval', 'workflow'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('memory')
    expect(res.stderr).toContain('north-star')
    expect(res.stderr).toContain('gate')
  })
})
