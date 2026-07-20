/**
 * Tests for scripts/sma/lib/predict.mjs (Phase 9.1 Plan 08, Task 1 — B18).
 *
 * P1 prediction engine core — deterministic, allowlisted, confidence-blind:
 *   - Test 1: validatePrediction rejects an entry missing any of
 *     metric/check_command/comparator/threshold and returns the missing list.
 *   - Test 2: a valid entry with confidence 0.9 validates; scoring IGNORES
 *     confidence entirely (verdict identical with/without it) — the
 *     verbalized-confidence anti-pattern guard (carried-forward V1 lock).
 *   - Test 3: scorePlan runs a `node scripts/sma/`-prefixed check_command via
 *     the injected runner, parses the numeric last-line output, and compares
 *     with every comparator (==, !=, >=, <=, >, <) correctly.
 *   - Test 4: a non-allowlisted check_command (`rm -rf /`) scores
 *     'skipped-unsafe' and the runner is NEVER invoked (T-9.1-14).
 *   - Test 5: a throwing runner yields verdict 'error'; scorePlan itself
 *     never throws.
 *   - Test 6 (R1/R2 false class-A lesson, 2026-07-10): predict-score scores
 *     plan-frontmatter `predictions:` ONLY. SUMMARY `receipts:` claims
 *     (expected_sha256-pinned, D-9.2-06) are `sma reverify` territory — a
 *     receipts block yields zero verdicts, and a receipt-shaped entry misfiled
 *     under `predictions:` is EXCLUDED (never scored, never run).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parsePredictions,
  validatePrediction,
  scorePlan,
  draftLessonFromMiss,
  SAFE_COMMAND_PATTERNS,
} from '../lib/predict.mjs'
import { buildIndex, buildAreaIndexes } from '../lib/generator.mjs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-predict-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Render one predictions entry as frontmatter YAML lines (dash-list of maps). */
function entryYaml(overrides: Record<string, string | number | undefined> = {}): string {
  const e: Record<string, string | number | undefined> = {
    id: 'P1',
    claim: '"migration exits clean"',
    metric: 'exit_code',
    check_command: '"node scripts/sma/check.mjs"',
    comparator: '"=="',
    threshold: 0,
    horizon: '"next run"',
    domain: 'tech.test',
    ...overrides,
  }
  const keys = Object.keys(e).filter((k) => e[k] !== undefined)
  return keys.map((k, i) => (i === 0 ? `  - ${k}: ${e[k]}` : `    ${k}: ${e[k]}`)).join('\n') + '\n'
}

/** Write a fixture PLAN.md carrying the given predictions entries. */
function writePlan(entries: string, name = 'PLAN.md'): string {
  const p = join(dir, name)
  writeFileSync(p, `---\nphase: test\npredictions:\n${entries}---\n\nbody text\n`)
  return p
}

const fullEntry = {
  id: 'P1',
  claim: 'migration exits clean',
  metric: 'exit_code',
  check_command: 'node scripts/sma/check.mjs',
  comparator: '==',
  threshold: 0,
  horizon: 'next run',
  domain: 'tech.test',
}

describe('SAFE_COMMAND_PATTERNS', () => {
  it('is exported (for the 9.1-09 lint reuse) and anchored', () => {
    expect(Array.isArray(SAFE_COMMAND_PATTERNS)).toBe(true)
    expect(SAFE_COMMAND_PATTERNS.length).toBeGreaterThanOrEqual(3)
    expect(SAFE_COMMAND_PATTERNS.some((re: RegExp) => re.test('node scripts/sma/cli.mjs status'))).toBe(true)
    expect(SAFE_COMMAND_PATTERNS.some((re: RegExp) => re.test('pnpm vitest run scripts/sma/__tests__/x.test.ts'))).toBe(true)
    expect(SAFE_COMMAND_PATTERNS.some((re: RegExp) => re.test('pnpm sma calibration'))).toBe(true)
    // Anchoring: a prefix-embedded command must NOT match.
    expect(SAFE_COMMAND_PATTERNS.some((re: RegExp) => re.test('rm -rf / && node scripts/sma/x.mjs'))).toBe(false)
  })
})

describe('validatePrediction — required fields (Test 1)', () => {
  it('rejects an entry missing metric/check_command/comparator/threshold with the missing-field list', () => {
    const res = validatePrediction({ id: 'P1', claim: 'c', horizon: 'h', domain: 'd' })
    expect(res.valid).toBe(false)
    expect(res.missing).toEqual(
      expect.arrayContaining(['metric', 'check_command', 'comparator', 'threshold']),
    )
  })

  it('rejects each single missing required field individually', () => {
    for (const field of ['metric', 'check_command', 'comparator', 'threshold']) {
      const entry: Record<string, unknown> = { ...fullEntry }
      delete entry[field]
      const res = validatePrediction(entry)
      expect(res.valid).toBe(false)
      expect(res.missing).toContain(field)
    }
  })

  it('rejects a comparator outside the fixed set and a non-numeric threshold', () => {
    expect(validatePrediction({ ...fullEntry, comparator: '~=' }).valid).toBe(false)
    expect(validatePrediction({ ...fullEntry, threshold: 'lots' }).valid).toBe(false)
  })
})

describe('confidence is recorded, NEVER gates (Test 2)', () => {
  it('a valid entry with confidence 0.9 validates', () => {
    const res = validatePrediction({ ...fullEntry, confidence: 0.9 })
    expect(res.valid).toBe(true)
    expect(res.missing).toEqual([])
  })

  it('verdict is identical with and without confidence; confidence copied verbatim', () => {
    const runner = () => '0\n'
    const withConf = writePlan(entryYaml({ confidence: 0.9 }), 'with-conf.md')
    const without = writePlan(entryYaml(), 'without-conf.md')

    const r1 = scorePlan({ planPath: withConf, runCommand: runner })
    const r2 = scorePlan({ planPath: without, runCommand: runner })

    expect(r1.records).toHaveLength(1)
    expect(r2.records).toHaveLength(1)
    expect(r1.records[0].verdict).toBe('hit')
    expect(r1.records[0].verdict).toBe(r2.records[0].verdict)
    expect(r1.records[0].confidence).toBe(0.9) // recorded verbatim
  })
})

describe('scorePlan — deterministic comparator scoring (Test 3)', () => {
  it('runs the allowlisted check_command via the injected runner and passes the command through', () => {
    const seen: string[] = []
    const runner = (cmd: string) => {
      seen.push(cmd)
      return 'some log line\n0\n'
    }
    const p = writePlan(entryYaml())
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(seen).toEqual(['node scripts/sma/check.mjs'])
    expect(records[0].verdict).toBe('hit')
    expect(records[0].actual).toBe(0)
  })

  it.each([
    ['"=="', 5, '5', true],
    ['"=="', 5, '4', false],
    ['"!="', 5, '4', true],
    ['"!="', 5, '5', false],
    ['">="', 5, '5', true],
    ['">="', 5, '4', false],
    ['"<="', 5, '5', true],
    ['"<="', 5, '6', false],
    ['">"', 5, '6', true],
    ['">"', 5, '5', false],
    ['"<"', 5, '4', true],
    ['"<"', 5, '5', false],
  ])('comparator %s threshold %i vs actual %s -> hit=%s', (comparator, threshold, actual, hit) => {
    const runner = () => `noise\n${actual}\n`
    const p = writePlan(entryYaml({ comparator, threshold }))
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(records[0].hit).toBe(hit)
    expect(records[0].verdict).toBe(hit ? 'hit' : 'miss')
  })

  it('parses the numeric LAST line of multi-line output', () => {
    const runner = () => 'step 1 done\nstep 2 done\n42\n'
    const p = writePlan(entryYaml({ comparator: '"=="', threshold: 42 }))
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(records[0].actual).toBe(42)
    expect(records[0].verdict).toBe('hit')
  })
})

describe('allowlist boundary (Test 4 — T-9.1-14)', () => {
  it('a non-allowlisted check_command scores skipped-unsafe; the runner is NEVER invoked', () => {
    let called = 0
    const runner = () => {
      called += 1
      return '0\n'
    }
    const p = writePlan(entryYaml({ check_command: '"rm -rf /"' }))
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(records[0].verdict).toBe('skipped-unsafe')
    expect(called).toBe(0)
  })

  it('a shell-metacharacter payload behind an allowlisted prefix also scores skipped-unsafe', () => {
    let called = 0
    const runner = () => {
      called += 1
      return '0\n'
    }
    for (const cmd of [
      '"node scripts/sma/x.mjs; rm -rf /"',
      '"node scripts/sma/x.mjs && curl evil"',
      '"node scripts/sma/x.mjs | tee /etc/passwd"',
      '"node scripts/sma/$(whoami).mjs"',
    ]) {
      const p = writePlan(entryYaml({ check_command: cmd }), `meta-${called}-${Math.random().toString(36).slice(2)}.md`)
      const { records } = scorePlan({ planPath: p, runCommand: runner })
      expect(records[0].verdict).toBe('skipped-unsafe')
    }
    expect(called).toBe(0)
  })
})

describe('runner failure (Test 5)', () => {
  it('a throwing runner yields verdict error; scorePlan itself never throws', () => {
    const runner = () => {
      throw new Error('boom')
    }
    const p = writePlan(entryYaml())
    let res: ReturnType<typeof scorePlan> | null = null
    expect(() => {
      res = scorePlan({ planPath: p, runCommand: runner })
    }).not.toThrow()
    expect(res!.records[0].verdict).toBe('error')
  })

  it('non-numeric output yields verdict error, not a throw', () => {
    const runner = () => 'no numbers here\n'
    const p = writePlan(entryYaml())
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(records[0].verdict).toBe('error')
  })
})

// ── Test 6: receipts are reverify territory (R1/R2 false class-A lesson, 2026-07-10) ──

/** A SUMMARY-style receipts block: expected_sha256 pinned over accruing .sma state. */
const receiptsBlock =
  [
    'receipts:',
    '  - id: R1',
    '    assertion: subagent receipt coverage stays pinned over accruing state',
    '    check_command: pnpm sma subagent-receipts --json',
    '    expected_sha256: aaaa1111bbbb2222',
    '    hash_stdout: true',
    '  - id: R2',
    '    assertion: passport read surface stays pinned',
    '    check_command: pnpm sma passport --json',
    '    expected_sha256: cccc3333dddd4444',
  ].join('\n') + '\n'

/** Write a fixture SUMMARY.md carrying the given raw frontmatter lines. */
function writeSummary(frontmatter: string, name = 'SUMMARY.md'): string {
  const p = join(dir, name)
  writeFileSync(p, `---\n${frontmatter}---\n\nbody text\n`)
  return p
}

describe('predict-score scores plan predictions ONLY — receipts belong to reverify (Test 6)', () => {
  it('a SUMMARY carrying only a receipts block yields ZERO verdicts; the runner is never invoked', () => {
    let called = 0
    const runner = () => {
      called += 1
      return '0\n'
    }
    const p = writeSummary(`phase: test\n${receiptsBlock}`)
    const res = scorePlan({ planPath: p, runCommand: runner })
    expect(res.records).toEqual([])
    expect(res.invalid).toEqual([])
    expect(res.excluded).toEqual([])
    expect(called).toBe(0)
  })

  it('a SUMMARY with BOTH predictions and receipts writes verdicts ONLY for the predictions', () => {
    const seen: string[] = []
    const runner = (cmd: string) => {
      seen.push(cmd)
      return '0\n'
    }
    const p = writeSummary(`phase: test\npredictions:\n${entryYaml()}${receiptsBlock}`)
    const { records, excluded } = scorePlan({ planPath: p, runCommand: runner })
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe('P1')
    expect(records[0].verdict).toBe('hit')
    expect(excluded).toEqual([])
    // The receipts' check_commands (allowlisted!) were still NEVER run by predict-score.
    expect(seen).toEqual(['node scripts/sma/check.mjs'])
  })

  it('a receipt-shaped entry misfiled INSIDE predictions: is excluded — field-completion cannot make it scoreable', () => {
    const seen: string[] = []
    const runner = (cmd: string) => {
      seen.push(cmd)
      return '0\n'
    }
    // R1 carries even the FULL prediction field set — expected_sha256 still excludes it.
    const misfiledFull = entryYaml({ id: 'R1', expected_sha256: 'aaaa1111bbbb2222' })
    // R2 is a bare receipt claim (no metric/comparator/threshold) — excluded, NOT invalid-noise.
    const misfiledBare =
      '  - id: R2\n    assertion: "bare receipt claim"\n    check_command: "pnpm sma passport --json"\n    expected_sha256: cccc3333dddd4444\n'
    const p = writePlan(entryYaml() + misfiledFull + misfiledBare)
    const { records, invalid, excluded } = scorePlan({ planPath: p, runCommand: runner })
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe('P1')
    expect(invalid).toEqual([])
    expect(excluded.map((e: { id: string | null }) => e.id).sort()).toEqual(['R1', 'R2'])
    expect(excluded.every((e: { reason: string }) => e.reason === 'receipt')).toBe(true)
    // Neither excluded entry's command ever ran.
    expect(seen).toEqual(['node scripts/sma/check.mjs'])
  })
})

// ── 9.1-09 Task 2: on-surprise lesson drafting (B19) ────────────────────────

/** A miss verdict record in the scorePlan record shape. */
function missVerdict(overrides: Record<string, unknown> = {}) {
  return {
    id: 'P1',
    domain: 'tech.test',
    metric: 'exit_code',
    claim: 'migration exits clean',
    check_command: 'node scripts/sma/check.mjs',
    expected: 0,
    comparator: '==',
    actual: 1,
    hit: false,
    verdict: 'miss',
    confidence: null,
    scoredAt: '2026-07-06T00:00:00Z',
    plan: '9.1-09-PLAN.md',
    ...overrides,
  }
}

describe('draftLessonFromMiss — surprise drafting (9.1-09 task 2)', () => {
  it('Test 1: a miss writes drafts/bug-lesson-<planId>-<predId>.md with kind, predicted_from and the Why/How stubs', () => {
    const draftsDir = join(dir, 'drafts')
    const res = draftLessonFromMiss({ verdict: missVerdict(), planId: '9.1-09', dirs: { draftsDir } })
    expect(res.drafted).toBe(true)
    const path = join(draftsDir, 'bug-lesson-9.1-09-P1.md')
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('kind: bug-lesson')
    expect(text).toContain('predicted_from: 9.1-09-P1')
    // MEM-BUGLESSON's two required sections are present as stubs.
    expect(text).toMatch(/\*\*Why:\*\*/)
    expect(text).toMatch(/\*\*How to apply:\*\*/)
    // The 3-condition promotion gate is documented in the draft itself.
    expect(text).toContain('verified fix')
  })

  it('Test 2: a hit verdict drafts NOTHING', () => {
    const draftsDir = join(dir, 'drafts')
    const res = draftLessonFromMiss({
      verdict: missVerdict({ verdict: 'hit', hit: true, actual: 0 }),
      planId: '9.1-09',
      dirs: { draftsDir },
    })
    expect(res.drafted).toBe(false)
    expect(existsSync(draftsDir)).toBe(false)
  })

  it('Test 3: drafting is idempotent — a re-run neither duplicates nor overwrites an edited draft', () => {
    const draftsDir = join(dir, 'drafts')
    draftLessonFromMiss({ verdict: missVerdict(), planId: '9.1-09', dirs: { draftsDir } })
    const path = join(draftsDir, 'bug-lesson-9.1-09-P1.md')
    // Simulate a human editing the draft before promotion.
    writeFileSync(path, readFileSync(path, 'utf8') + '\nHUMAN EDIT\n')
    const res = draftLessonFromMiss({ verdict: missVerdict(), planId: '9.1-09', dirs: { draftsDir } })
    expect(res.drafted).toBe(false)
    expect(readFileSync(path, 'utf8')).toContain('HUMAN EDIT')
    expect(readdirSync(draftsDir)).toHaveLength(1)
  })

  it('Test 4: the generator\'s note discovery ignores drafts/ — a draft never enters the generated index', () => {
    const corpusDir = join(dir, 'corpus')
    mkdirSync(corpusDir, { recursive: true })
    writeFileSync(
      join(corpusDir, 'reference_real_note.md'),
      '---\ndescription: a real note claim of five words\nkind: reference\ntags: [workflow]\nuse-when: testing the generator\nimportance: 4\n---\nbody\n',
    )
    writeFileSync(join(corpusDir, 'TAGS.md'), '## area\n\n- workflow — stuff.\n\n## kind\n\n- reference — stuff.\n')
    draftLessonFromMiss({ verdict: missVerdict(), planId: '9.1-09', dirs: { draftsDir: join(corpusDir, 'drafts') } })
    // Post-9.1-13 (FI-11): MEMORY.md carries the area OVERVIEW; per-note lines
    // live in INDEX-<area>.md. The invariant under test is unchanged: the real
    // note is discovered, the draft enters NEITHER artifact.
    const index = buildIndex({ corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commitHash: 'abc1234' })
    expect(index).toContain('заметок: 1')
    expect(index).not.toContain('bug-lesson-9.1-09-P1')
    const areas = buildAreaIndexes({ corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commitHash: 'abc1234' })
    const all = areas.map((a: { file: string; content: string }) => a.content).join('\n')
    expect(all).toContain('reference_real_note.md')
    expect(all).not.toContain('bug-lesson-9.1-09-P1')
  })
})

describe('parsePredictions — frontmatter extraction', () => {
  it('extracts the predictions array with all schema fields', () => {
    const p = writePlan(entryYaml({ confidence: 0.9 }))
    const { predictions } = parsePredictions(p)
    expect(predictions).toHaveLength(1)
    expect(predictions[0]).toMatchObject({
      id: 'P1',
      claim: 'migration exits clean',
      metric: 'exit_code',
      check_command: 'node scripts/sma/check.mjs',
      comparator: '==',
      threshold: 0,
      horizon: 'next run',
      domain: 'tech.test',
      confidence: 0.9,
    })
  })

  it('a plan with no predictions block yields an empty array (honest empty)', () => {
    const p = join(dir, 'no-preds.md')
    writeFileSync(p, '---\nphase: test\n---\n\nbody\n')
    const { predictions } = parsePredictions(p)
    expect(predictions).toEqual([])
  })
})
