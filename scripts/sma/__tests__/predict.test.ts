/**
 * Tests for scripts/sma/lib/predict.mjs (B18).
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
 *     'skipped-unsafe' and the runner is NEVER invoked.
 *   - Test 5: a throwing runner yields verdict 'error'; scorePlan itself
 *     never throws.
 *   - Test 6 (R1/R2 false class-A lesson, 2026-07-10): predict-score scores
 *     plan-frontmatter `predictions:` ONLY. SUMMARY `receipts:` claims
 *     (expected_sha256-pinned) are `sma reverify` territory — a
 *     receipts block yields zero verdicts, and a receipt-shaped entry misfiled
 *     under `predictions:` is EXCLUDED (never scored, never run).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseFrontmatterEntries,
  parsePredictions,
  validatePrediction,
  scorePlan,
  draftLessonFromMiss,
  SAFE_COMMAND_PATTERNS,
  isSafeCommand,
  horizonReached,
  makeExecRunner,
  draftLessonsForRecords,
  RUN_BUDGET_MS,
  scoringTally,
  isNewDivergence,
  receiptPairKey,
  lastReceiptVerdicts,
  recordReceiptRun,
  unsafeCommandReason,
  measurementVerdict,
} from '../lib/predict.mjs'
import { buildIndex, buildAreaIndexes } from '../lib/generator.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  it('is exported (for the lint reuse) and anchored', () => {
    expect(Array.isArray(SAFE_COMMAND_PATTERNS)).toBe(true)
    expect(SAFE_COMMAND_PATTERNS.length).toBeGreaterThanOrEqual(3)
    expect(SAFE_COMMAND_PATTERNS.some((re: RegExp) => re.test('node scripts/sma/cli.mjs status'))).toBe(true)
    expect(SAFE_COMMAND_PATTERNS.some((re: RegExp) => re.test('pnpm vitest run scripts/sma/__tests__/x.test.ts'))).toBe(true)
    expect(SAFE_COMMAND_PATTERNS.some((re: RegExp) => re.test('pnpm sma calibration'))).toBe(true)
    // Anchoring: a prefix-embedded command must NOT match.
    expect(SAFE_COMMAND_PATTERNS.some((re: RegExp) => re.test('rm -rf / && node scripts/sma/x.mjs'))).toBe(false)
  })

  it('admits the release-gate forms — test / pack / run <script> for npm, pnpm and yarn', () => {
    for (const pm of ['npm', 'pnpm', 'yarn']) {
      expect(isSafeCommand(`${pm} test`)).toBe(true)
      expect(isSafeCommand(`${pm} test --silent`)).toBe(true)
      expect(isSafeCommand(`${pm} pack`)).toBe(true)
      expect(isSafeCommand(`${pm} run build`)).toBe(true)
      expect(isSafeCommand(`${pm} run test:unit`)).toBe(true)
      expect(isSafeCommand(`${pm} run build --if-present`)).toBe(true)
    }
    // The forms that were already admitted are untouched.
    expect(isSafeCommand('node scripts/sma/cli.mjs status')).toBe(true)
    expect(isSafeCommand('pnpm vitest run scripts/sma/__tests__/x.test.ts')).toBe(true)
  })

  it('still refuses registry-fetching package-manager verbs and every metacharacter form', () => {
    // These fetch and execute code the local tree never vouched for.
    for (const bad of [
      'npm install left-pad',
      'npm i left-pad',
      'npm exec cowsay',
      'npx cowsay',
      'pnpm add left-pad',
      'pnpm dlx cowsay',
      'yarn add left-pad',
      'yarn dlx cowsay',
      'npm publish',
    ]) {
      expect(isSafeCommand(bad)).toBe(false)
    }
    // A bare script name without `run` is not a script invocation we can bound.
    expect(isSafeCommand('yarn build')).toBe(false)
    expect(isSafeCommand('npm run')).toBe(false)
    // The charset guard still runs first — no chaining, substitution or redirect.
    expect(isSafeCommand('npm test; rm -rf /')).toBe(false)
    expect(isSafeCommand('npm test && curl evil.example')).toBe(false)
    expect(isSafeCommand('npm run build > /etc/passwd')).toBe(false)
    expect(isSafeCommand('npm run $(whoami)')).toBe(false)
    // Anchoring: the release-gate form embedded after another command.
    expect(isSafeCommand('rm -rf / npm test')).toBe(false)
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

describe('allowlist boundary (Test 4)', () => {
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

// ── On-surprise lesson drafting (B19) ───────────────────────────────────────

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

describe('draftLessonFromMiss — surprise drafting', () => {
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
    // After the index restructure: MEMORY.md carries the area OVERVIEW; per-note lines
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

describe('horizon gate — a claim that is not due yet is not scored', () => {
  it('horizonReached: only an unambiguously future horizon reads as not-arrived', () => {
    // Version horizons, measured against the current version.
    expect(horizonReached('V3.2', { currentVersion: '3.1.9' })).toBe(false)
    expect(horizonReached('v3.2.1', { currentVersion: '3.2.0' })).toBe(false)
    expect(horizonReached('4', { currentVersion: '3.9.9' })).toBe(false)
    expect(horizonReached('V3.2', { currentVersion: '3.2' })).toBe(true) // the horizon IS now
    expect(horizonReached('V3.2', { currentVersion: '5.0.4' })).toBe(true)
    expect(horizonReached('V1.0', { currentVersion: '1.0.1' })).toBe(true)

    // Date horizons, measured against `now`.
    expect(horizonReached('2099-01-01', { now: '2026-08-02T10:00:00Z' })).toBe(false)
    expect(horizonReached('2026-08-03', { now: '2026-08-02T10:00:00Z' })).toBe(false)
    expect(horizonReached('2026-08-02', { now: '2026-08-02T10:00:00Z' })).toBe(true)
    expect(horizonReached('2020-01-01', { now: '2026-08-02T10:00:00Z' })).toBe(true)

    // Unknown / unparseable -> null: cannot tell, so today's behaviour stands.
    expect(horizonReached('next run', { currentVersion: '3.1' })).toBeNull()
    expect(horizonReached('after the next release', { now: '2026-08-02' })).toBeNull()
    expect(horizonReached('', { currentVersion: '3.1' })).toBeNull()
    expect(horizonReached(undefined as unknown as string, {})).toBeNull()
    // A version horizon with nothing to compare against is NOT a skip.
    expect(horizonReached('V3.2', {})).toBeNull()
    expect(horizonReached('V3.2', { currentVersion: 'not-a-version' })).toBeNull()
  })

  it('scorePlan: a future-version horizon is registered as not-due — no verdict, runner never invoked', () => {
    const planPath = writePlan(entryYaml({ horizon: '"V3.2"' }))
    const runCommand = vi.fn(() => '0\n')

    const { records, notDue, invalid } = scorePlan({ planPath, runCommand, currentVersion: '3.1.0' })

    expect(records).toHaveLength(0)
    expect(invalid).toHaveLength(0)
    expect(notDue).toHaveLength(1)
    expect(notDue[0]).toMatchObject({ id: 'P1', horizon: 'V3.2', reason: 'horizon-not-reached' })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('scorePlan: the same prediction IS scored once the horizon arrives', () => {
    const planPath = writePlan(entryYaml({ horizon: '"V3.2"' }))
    const runCommand = vi.fn(() => '0\n')

    const { records, notDue } = scorePlan({ planPath, runCommand, currentVersion: '3.2.0' })

    expect(notDue).toHaveLength(0)
    expect(records).toHaveLength(1)
    expect(records[0].verdict).toBe('hit')
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it('scorePlan: a future DATE horizon is not-due; a past one is scored', () => {
    const planPath = writePlan(entryYaml({ horizon: '2099-01-01' }))
    const future = scorePlan({ planPath, runCommand: () => '0\n', now: '2026-08-02T00:00:00Z' })
    expect(future.records).toHaveLength(0)
    expect(future.notDue).toHaveLength(1)

    const pastPlan = writePlan(entryYaml({ horizon: '2020-01-01' }), 'PAST-PLAN.md')
    const past = scorePlan({ planPath: pastPlan, runCommand: () => '0\n', now: '2026-08-02T00:00:00Z' })
    expect(past.notDue).toHaveLength(0)
    expect(past.records[0].verdict).toBe('hit')
  })

  it('scorePlan: an unparseable horizon keeps the existing behaviour — scored, whatever the version', () => {
    const planPath = writePlan(entryYaml())
    const scored = scorePlan({ planPath, runCommand: () => '0\n', currentVersion: '0.0.1' })
    expect(scored.notDue).toHaveLength(0)
    expect(scored.records).toHaveLength(1)
    expect(scored.records[0].verdict).toBe('hit')
  })

  it('scorePlan: a version horizon with no current version is scored, not skipped', () => {
    const planPath = writePlan(entryYaml({ horizon: '"V3.2"' }))
    const scored = scorePlan({ planPath, runCommand: () => '0\n' })
    expect(scored.notDue).toHaveLength(0)
    expect(scored.records).toHaveLength(1)
  })
})

// ── The exit code as a first-class unit of measurement ──────────────────────
//
// A prediction that says «the suite is green» used to be unable to be WRONG:
// the scorer's runner threw on a nonzero exit, so a failing suite produced
// 'error' and a passing one produced 'error' too (no numeric last line).
// The mechanism built to catch our mistakes could not catch them. These cases
// pin the fix AND pin that the safety boundary did not move a single character.

/** A runner in the contract the scorer now asks for: both halves of the run. */
function ranWith(stdout: string, exitCode: number) {
  return { stdout, exitCode }
}

describe('exit code as a unit of measurement', () => {
  it('a command exiting 1 under measure exit-code with «== 0» is a MISS, not an error', () => {
    const runner = () => ranWith('some log line\n', 1)
    const p = writePlan(entryYaml({ measure: '"exit-code"', comparator: '"=="', threshold: 0 }))
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(records[0].verdict).toBe('miss')
    expect(records[0].hit).toBe(false)
    expect(records[0].actual).toBe(1)
  })

  it('the same entry exiting 0 is a HIT', () => {
    const runner = () => ranWith('all tests passed\n', 0)
    const p = writePlan(entryYaml({ measure: '"exit-code"', comparator: '"=="', threshold: 0 }))
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(records[0].verdict).toBe('hit')
    expect(records[0].actual).toBe(0)
  })

  it('a runner reporting output ONLY cannot answer an exit-code claim — error, never a silent hit', () => {
    const runner = () => 'plenty of words, no exit code\n'
    const p = writePlan(entryYaml({ measure: '"exit-code"', comparator: '"=="', threshold: 0 }))
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(records[0].verdict).toBe('error')
  })

  it('an unknown measure fails validation instead of quietly falling back', () => {
    const p = writePlan(entryYaml({ measure: '"stderr"' }))
    const { records, invalid } = scorePlan({ planPath: p, runCommand: () => ranWith('', 0) })
    expect(records).toEqual([])
    expect(invalid[0].errors.join(' ')).toContain('measure')
  })
})

describe('the safety boundary did NOT move (reverse checks)', () => {
  it('a connector with a substitution is still skipped-unsafe and the runner is NEVER invoked', () => {
    let called = 0
    const runner = () => {
      called += 1
      return ranWith('', 0)
    }
    const p = writePlan(entryYaml({ measure: '"exit-code"', check_command: '"npm test && echo $(whoami)"' }))
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(records[0].verdict).toBe('skipped-unsafe')
    expect(called).toBe(0)
  })

  it('«change directory, then run» written as a STRING is still skipped-unsafe', () => {
    let called = 0
    const runner = () => {
      called += 1
      return ranWith('', 0)
    }
    const p = writePlan(entryYaml({ measure: '"exit-code"', check_command: '"cd ../elsewhere && npm test"' }))
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(records[0].verdict).toBe('skipped-unsafe')
    expect(called).toBe(0)
  })
})

describe('the working directory is a FIELD, never joined into the command string', () => {
  it('the cwd field reaches the runner as a parameter and leaves the command untouched', () => {
    const seen: Array<{ cmd: string; opts: { cwd?: string } }> = []
    const runner = (cmd: string, opts: { cwd?: string } = {}) => {
      seen.push({ cmd, opts })
      return ranWith('', 3)
    }
    const p = writePlan(entryYaml({ measure: '"exit-code"', cwd: `'${dir}'`, comparator: '"=="', threshold: 0 }))
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(seen).toHaveLength(1)
    expect(seen[0].cmd).toBe('node scripts/sma/check.mjs') // no connector, no path glued on
    expect(seen[0].opts.cwd).toBe(dir)
    // A directory where the command fails is a MISS or an error — never «skipped as unsafe».
    expect(records[0].verdict).toBe('miss')
    expect(records[0].verdict).not.toBe('skipped-unsafe')
  })
})

describe('backward compatibility: the default measure is unchanged', () => {
  it('an entry with NO measure keeps the numeric-last-line behaviour, byte for byte', () => {
    const p = writePlan(entryYaml({ comparator: '"=="', threshold: 42 }))
    const hit = scorePlan({ planPath: p, runCommand: () => 'noise\n42\n' })
    expect(hit.records[0].verdict).toBe('hit')
    expect(hit.records[0].actual).toBe(42)

    const p2 = writePlan(entryYaml({ comparator: '"=="', threshold: 42 }), 'PLAN2.md')
    const miss = scorePlan({ planPath: p2, runCommand: () => 'noise\n7\n' })
    expect(miss.records[0].verdict).toBe('miss')

    const p3 = writePlan(entryYaml({ comparator: '"=="', threshold: 42 }), 'PLAN3.md')
    const err = scorePlan({ planPath: p3, runCommand: () => 'no numbers here\n' })
    expect(err.records[0].verdict).toBe('error')
  })

  it('an entry with NO measure ignores the exit code a new-contract runner reports', () => {
    const p = writePlan(entryYaml({ comparator: '"=="', threshold: 42 }))
    const { records } = scorePlan({ planPath: p, runCommand: () => ranWith('noise\n42\n', 1) })
    expect(records[0].verdict).toBe('hit') // the last line is the fact; the exit code is not
  })
})

// ── «Не смог измерить» is NOT «you were wrong» ──────────────────────────────
// Found by a run, not by reasoning: the first real verdict this workspace's
// ledgers ever carried was a MISS produced by the runner's own two-minute
// budget, not by the checked thing failing. A killed process reports no exit
// code at all (status null, signal SIGTERM, code ETIMEDOUT), and the runner
// substituted 1 — so «I could not measure» was written down as a claim about
// the world. These cases pin the difference machine-readably.

/** The real runner, driven against real child processes — no fake in sight. */
function tmpScript(body: string, name: string): string {
  const p = join(dir, name)
  writeFileSync(p, body)
  return `node "${p}"`
}

describe('a run that never finished is not a verdict about the world', () => {
  it('a command killed by its own time budget reports «not measured», never exit code 1', async () => {
    const { execSync } = await import('node:child_process')
    // cwd stays OUT of the temp dir on purpose: a child killed by the budget
    // may outlive the assertion for a moment, and a live process holding the
    // temp dir as its cwd would make the cleanup fail on Windows.
    const run = makeExecRunner({ execSync, cwd: process.cwd(), timeoutMs: 400 })
    const res = run(tmpScript('setTimeout(() => {}, 8000)\n', 'sleeper.mjs'))
    expect(res.notMeasured).toBe('timeout')
    expect(res.exitCode).toBe(null)
  }, 30_000)

  it('a command that RAN and exited nonzero reports that code and claims nothing about measurement', async () => {
    const { execSync } = await import('node:child_process')
    const run = makeExecRunner({ execSync, cwd: process.cwd(), timeoutMs: 30_000 })
    const res = run(tmpScript('process.exit(3)\n', 'exit3.mjs'))
    expect(res.exitCode).toBe(3)
    expect(res.notMeasured).toBe(null)
  }, 30_000)

  it('the working directory still travels as a PARAMETER — the real runner never splices it in', async () => {
    const { execSync } = await import('node:child_process')
    const run = makeExecRunner({ execSync, cwd: process.cwd(), timeoutMs: 30_000 })
    const cmd = tmpScript('process.stdout.write(process.cwd())\n', 'pwd.mjs')
    const res = run(cmd, { cwd: dir })
    expect(res.exitCode).toBe(0)
    expect(String(res.stdout).toLowerCase()).toContain('sma-predict-')
    expect(cmd).not.toContain('&&')
  }, 30_000)
})

describe('the unfinished run travels all the way into the record', () => {
  // The shape handed to scorePlan below is the shape the REAL runner produces
  // for a timeout — pinned by the first case of the previous block.
  const timedOut = () => ({ stdout: '', exitCode: null, notMeasured: 'timeout' })

  it('a timed-out run is NOT a miss, and the record says why', () => {
    const p = writePlan(entryYaml({ measure: '"exit-code"', comparator: '"=="', threshold: 0 }))
    const { records } = scorePlan({ planPath: p, runCommand: timedOut })
    expect(records[0].verdict).not.toBe('miss')
    expect(records[0].verdict).toBe('error')
    expect(records[0].not_measured).toBe('timeout')
  })

  it('a command that RAN and exited nonzero is STILL a MISS — the fix does not launder misses away', () => {
    const p = writePlan(entryYaml({ measure: '"exit-code"', comparator: '"=="', threshold: 0 }), 'PLAN-MISS.md')
    const { records } = scorePlan({ planPath: p, runCommand: () => ({ stdout: '', exitCode: 3, notMeasured: null }) })
    expect(records[0].verdict).toBe('miss')
    expect(records[0].actual).toBe(3)
    expect(records[0].not_measured).toBeUndefined()
  })

  it('the default measure is judged the same way: an unfinished run is not a wrong number', () => {
    const p = writePlan(entryYaml({ comparator: '"=="', threshold: 42 }), 'PLAN-LASTLINE.md')
    const { records } = scorePlan({ planPath: p, runCommand: timedOut })
    expect(records[0].verdict).toBe('error')
    expect(records[0].not_measured).toBe('timeout')
  })
})

describe('an unfinished run drafts NO lesson — the wire, not a reading', () => {
  it('the drafter is invoked for the miss and NOT for the unfinished run', () => {
    let called = 0
    const seen: string[] = []
    const draft = ({ verdict }: { verdict: { id: string } }) => {
      called += 1
      seen.push(verdict.id)
      return { drafted: true, path: join(dir, `draft-${verdict.id}.md`) }
    }
    const records = [
      { id: 'PA', verdict: 'error', not_measured: 'timeout' },
      { id: 'PB', verdict: 'miss', claim: 'c', metric: 'm', comparator: '==', expected: 0, check_command: 'x' },
      { id: 'PC', verdict: 'hit' },
      { id: 'PD', verdict: 'skipped-unsafe' },
    ]
    const out = draftLessonsForRecords({ records, planId: 'alpha', dirs: { draftsDir: dir }, draft })
    expect(called).toBe(1)
    expect(seen).toEqual(['PB'])
    expect(out.map((d: { id: string }) => d.id)).toEqual(['PB'])
  })

  it('the scoring verb drafts through that one helper — there is no second drafting loop in the tree', () => {
    const src = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8')
    expect(src).toContain('draftLessonsForRecords(')
  })
})

describe('the time budget fits the thing the runner is asked to measure', () => {
  it('the budget clears this product own suite measured under load (715 s), not just idle (134 s)', () => {
    expect(RUN_BUDGET_MS).toBeGreaterThan(715_000)
  })

  it('the verdict-producing verbs all build their runner from that one factory', () => {
    const src = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8')
    const uses = src.match(/makeExecRunner\(/g) || []
    expect(uses.length).toBeGreaterThanOrEqual(3)
  })
})

// ── the closing line of a scoring run is COMPUTED, not narrated ──────────────

describe('scoringTally — how many verdicts, and what walked away without one', () => {
  it('counts verdicts about the world apart from entries that could not produce one', () => {
    const t = scoringTally({
      records: [
        { id: 'PA', verdict: 'hit' },
        { id: 'PB', verdict: 'miss' },
        { id: 'PC', verdict: 'skipped-unsafe' },
        { id: 'PD', verdict: 'error', not_measured: 'timeout' },
        { id: 'PE', verdict: 'error' },
      ],
      invalid: [{ id: 'PF' }],
      excluded: [{ id: 'PG' }],
      notDue: [{ id: 'PH' }],
      receiptsSkipped: 2,
    })
    expect(t.verdicts).toBe(2)
    expect(t.unscored).toBe(8)
    const byReason = Object.fromEntries(t.reasons.map((r) => [r.reason, r.count]))
    expect(byReason['не прошла границу безопасных команд']).toBe(1)
    expect(byReason['срок не наступил']).toBe(1)
    expect(byReason['поля не заполнены']).toBe(1)
    expect(byReason['территория перепроверки']).toBe(3)
    expect(byReason['измерить не удалось — запуск не завершился']).toBe(1)
    expect(byReason['запуск не дал факта']).toBe(1)
  })

  it('a refused command and an un-arrived horizon land in the SECOND number, never the first', () => {
    const t = scoringTally({
      records: [{ id: 'PA', verdict: 'skipped-unsafe' }],
      notDue: [{ id: 'PB', horizon: '2099-01-01' }],
    })
    expect(t.verdicts).toBe(0)
    expect(t.unscored).toBe(2)
    expect(t.reasons.map((r) => r.reason)).toEqual([
      'не прошла границу безопасных команд',
      'срок не наступил',
    ])
    // A clean run says so with an empty reason list, not with a missing line.
    const clean = scoringTally({ records: [{ id: 'PA', verdict: 'hit' }] })
    expect(clean.verdicts).toBe(1)
    expect(clean.unscored).toBe(0)
    expect(clean.reasons).toEqual([])
  })

  it('the scoring verb prints that computed line instead of counting on screen', () => {
    const src = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8')
    expect(src).toContain('scoringTally(')
  })
})

/**
 * Расхождение структурной перепроверки рождает черновик урока — но ТОЛЬКО новое.
 *
 * Почему эти кейсы существуют. Сочинитель черновика был готов и идемпотентен, его звали
 * четверо; главная ветка перепроверки — та, что ходит по структурным квитанциям, — не
 * звала его никогда: цикл клал запись в леджер и на этом останавливался. Самый частый
 * настоящий промах системы не рождал ничего.
 *
 * Врезать вызов «на каждое расхождение» было нельзя: в леджере этого воркспейса три
 * тысячи записей, из них тысяча семьсот промахов, а различных пар «сводка + id»,
 * когда-либо расходившихся, — почти две сотни. Один общий прогон высыпал бы до двух
 * сотен файлов, каталог черновиков стал бы нечитаемым, а человеческий гейт повышения
 * умер бы от объёма. Поэтому черновик рождается у расхождения, которое ЕЩЁ НЕ БЫЛО
 * расхождением.
 *
 * Кейсы утверждают ПРОВОД, а не вычисление: считается число обращений к подделке
 * сочинителя. «Черновик вычислен» и «черновик рождён обходом» — разные утверждения.
 */
describe('перепроверка квитанций: черновик рождается только у НОВОГО расхождения', () => {
  const SUMMARY = '.planning/phases/01-fixture/01-01-SUMMARY.md'

  /** Одна запись структурной перепроверки — та форма, что отдаёт verifyReceipt. */
  function receiptRecord(over: Record<string, unknown> = {}) {
    return {
      id: 'R1',
      summary: SUMMARY,
      planId: '01-01',
      assertion: 'квитанция воспроизводится',
      check_command: 'node scripts/sma/cli.mjs status',
      expected_sha256: 'a'.repeat(64),
      observed_sha256: 'b'.repeat(64),
      exitCode: 0,
      scoredAt: '2026-08-20T00:00:00.000Z',
      domain: 'sma.receipts',
      verdict: 'divergent',
      ...over,
    }
  }

  /** Одна строка леджера — та форма, что кладёт туда верб перепроверки. */
  function ledgerRow(over: Record<string, unknown> = {}) {
    return {
      id: 'R1',
      summary: SUMMARY,
      domain: 'sma.receipts',
      verdict: 'hit',
      receipt_verdict: 'verified',
      scoredAt: '2026-08-19T00:00:00.000Z',
      ...over,
    }
  }

  /** Подделка сочинителя, которая ТОЛЬКО считает обращения. */
  function counter() {
    const calls: any[] = []
    const draft = (args: any) => {
      calls.push(args)
      return { drafted: true, path: join('drafts', `bug-lesson-${args.planId}-${args.verdict.id}.md`) }
    }
    return { calls, draft }
  }

  it('Тест 1: расхождение у пары, чей предыдущий вердикт успешен, зовёт сочинителя РОВНО ОДИН раз — и именно этой парой', () => {
    const { calls, draft } = counter()
    const res = recordReceiptRun({
      records: [receiptRecord()],
      readPrevious: () => [ledgerRow()],
      append: () => {},
      draft,
      dirs: { draftsDir: 'drafts' },
    })
    expect(calls, 'обход не позвал сочинителя — провод оборван').toHaveLength(1)
    expect(calls[0].verdict.id).toBe('R1')
    expect(calls[0].verdict.verdict).toBe('miss')
    expect(calls[0].verdict.check_command).toBe('node scripts/sma/cli.mjs status')
    expect(calls[0].planId).toBe('01-01')
    expect(res.drafted).toHaveLength(1)
  })

  it('Тест 2: та же пара, чей предыдущий вердикт УЖЕ был расхождением, не зовёт сочинителя ни разу', () => {
    const { calls, draft } = counter()
    const res = recordReceiptRun({
      records: [receiptRecord()],
      readPrevious: () => [ledgerRow({ verdict: 'miss', receipt_verdict: 'divergent' })],
      append: () => {},
      draft,
      dirs: { draftsDir: 'drafts' },
    })
    expect(calls, 'повторное расхождение позвало сочинителя — общий прогон высыпет сотни файлов').toHaveLength(0)
    expect(res.drafted).toHaveLength(0)
  })

  it('Тест 3: пары в леджере нет вовсе — расхождение новое по определению, сочинитель позван', () => {
    const { calls, draft } = counter()
    recordReceiptRun({
      records: [receiptRecord()],
      readPrevious: () => [],
      append: () => {},
      draft,
      dirs: { draftsDir: 'drafts' },
    })
    expect(calls).toHaveLength(1)
  })

  it('Тест 4: предыдущий вердикт прочитан ДО того, как в леджер дописан новый', () => {
    const order: string[] = []
    const ledger: any[] = [ledgerRow()] // пара сегодня подтверждается
    const { calls, draft } = counter()
    recordReceiptRun({
      records: [receiptRecord()],
      readPrevious: () => {
        order.push('read')
        return ledger.slice()
      },
      append: (r: any) => {
        order.push('append')
        ledger.push({ ...r, verdict: 'miss', receipt_verdict: r.verdict })
      },
      draft,
      dirs: { draftsDir: 'drafts' },
    })
    expect(order[0], 'леджер прочитан после дописывания — новизна считается по вердикту этого же прогона').toBe('read')
    expect(order.filter((o) => o === 'read'), 'леджер перечитывается на каждой записи').toHaveLength(1)
    // Обратный порядок увидел бы в леджере уже дописанное расхождение и не сочинил бы ничего.
    expect(calls).toHaveLength(1)
  })

  it('Тест 5: подтверждённая квитанция сочинителя не зовёт, но в леджер попадает', () => {
    const { calls, draft } = counter()
    const appended: any[] = []
    recordReceiptRun({
      records: [receiptRecord({ verdict: 'verified', observed_sha256: 'a'.repeat(64) })],
      readPrevious: () => [],
      append: (r: any) => appended.push(r),
      draft,
      dirs: { draftsDir: 'drafts' },
    })
    expect(calls).toHaveLength(0)
    expect(appended).toHaveLength(1)
  })

  it('срыв сочинителя не роняет перепроверку — сочинение остаётся best-effort', () => {
    const appended: any[] = []
    expect(() =>
      recordReceiptRun({
        records: [receiptRecord()],
        readPrevious: () => [],
        append: (r: any) => appended.push(r),
        draft: () => {
          throw new Error('диск полон')
        },
        dirs: { draftsDir: 'drafts' },
      }),
    ).not.toThrow()
    expect(appended).toHaveLength(1)
  })

  it('предикат новизны — чистая функция, и у неё свои кейсы', () => {
    expect(isNewDivergence({ previous: 'verified', current: 'divergent' })).toBe(true)
    expect(isNewDivergence({ previous: 'hit', current: 'divergent' })).toBe(true)
    expect(isNewDivergence({ previous: null, current: 'divergent' })).toBe(true)
    expect(isNewDivergence({ previous: 'divergent', current: 'divergent' })).toBe(false)
    expect(isNewDivergence({ previous: 'verified', current: 'verified' })).toBe(false)
    // Ни пропуск по границе команд, ни несостоявшийся запуск не были подтверждением,
    // что квитанция работала: расхождение после них — не свежий слом.
    expect(isNewDivergence({ previous: 'skipped-unsafe', current: 'divergent' })).toBe(false)
    expect(isNewDivergence({ previous: 'error', current: 'divergent' })).toBe(false)
  })

  it('пара «сводка + id» — одна и та же, как бы путь ни был написан', () => {
    const root = join(tmpdir(), 'sma-pair-key-root')
    const relKey = receiptPairKey({ summary: SUMMARY, id: 'R1' }, { repoRoot: root })
    const absKey = receiptPairKey({ summary: join(root, SUMMARY), id: 'R1' }, { repoRoot: root })
    expect(absKey, 'один рецепт под двумя написаниями пути = две истории, и залп повторится').toBe(relKey)
    expect(receiptPairKey({ summary: SUMMARY, id: 'R2' }, { repoRoot: root })).not.toBe(relKey)
  })

  it('карта последних вердиктов держит ПОСЛЕДНИЙ, а не первый', () => {
    const map = lastReceiptVerdicts([ledgerRow(), ledgerRow({ verdict: 'miss', receipt_verdict: 'divergent' })])
    expect(map.get(receiptPairKey({ summary: SUMMARY, id: 'R1' }))).toBe('divergent')
  })

  it('структурный обход перепроверки зовёт именно этот шаг, а не повторяет условие у себя', () => {
    const src = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8')
    expect(src).toContain('recordReceiptRun(')
  })
})

/**
 * parseFrontmatterEntries — ПЕРВЫЕ собственные тесты этого читателя.
 *
 * У него четыре потребителя (receipts, consequences, footprint, predictions) и до сих пор
 * НИ ОДНОГО своего теста: он проверялся только через них. Опись связей делает его пятым
 * потребителем и первым, кому нужен ВЛОЖЕННЫЙ ключ (`must_haves.key_links`), поэтому
 * контракт закрепляется здесь — иначе следующая правка отступов тихо сдвинет всех пятерых.
 */
describe('parseFrontmatterEntries — общий читатель списков frontmatter', () => {
  const NESTED_PLAN = [
    '---',
    'phase: parser-fixture',
    'plan: nested',
    'must_haves:',
    '  truths:',
    '    - "истина словами — читается человеком, не машиной"',
    '  artifacts:',
    '    - path: "tree/alpha.txt"',
    '      contains: "NEEDLE_ONE"',
    '    - path: "tree/beta.txt"',
    '      contains: "NEEDLE_TWO"',
    '  key_links:',
    '    - from: "tree/alpha.txt"',
    '      to: "tree/beta.txt"',
    '      via: "объяснение словами"',
    '      pattern: "NEEDLE_ONE"',
    '    - "связь, написанная прозой — машиной не проверяема"',
    'artifacts:',
    '  - path: "подделка-верхнего-уровня.txt"',
    'predictions:',
    '  - id: P1',
    '    claim: "верхний уровень читается ровно как раньше"',
    '    threshold: 3',
    '---',
    '',
    '# тело плана',
    '',
  ].join('\n')

  function writePlan(text: string, name = 'nested-PLAN.md'): string {
    const p = join(dir, name)
    writeFileSync(p, text, 'utf8')
    return p
  }

  it('односегментный ключ читает записи ровно как раньше — числа коэрцятся, ключ верхнего уровня', () => {
    const p = writePlan(NESTED_PLAN)
    const { entries, error } = parseFrontmatterEntries(p, 'predictions')
    expect(error).toBeUndefined()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'P1', threshold: 3 })
    expect(typeof (entries[0] as Record<string, unknown>).threshold).toBe('number')
  })

  it('вложенный ключ достаёт записи из-под родителя, а не одноимённого соседа сверху', () => {
    const p = writePlan(NESTED_PLAN)
    const nested = parseFrontmatterEntries(p, 'must_haves.artifacts').entries
    expect(nested).toHaveLength(2)
    expect(nested[0]).toMatchObject({ path: 'tree/alpha.txt', contains: 'NEEDLE_ONE' })
    expect(nested[1]).toMatchObject({ path: 'tree/beta.txt', contains: 'NEEDLE_TWO' })

    // Одноимённый ключ ВЕРХНЕГО уровня — отдельный блок; спутать их значит выдать
    // подделку за опись. Строгое «глубже родителя» на спуске держит именно это.
    const top = parseFrontmatterEntries(p, 'artifacts').entries
    expect(top).toHaveLength(1)
    expect(top[0]).toMatchObject({ path: 'подделка-верхнего-уровня.txt' })
    expect(JSON.stringify(nested)).not.toContain('подделка-верхнего-уровня')
  })

  it('отсутствующий ключ — пустой список без ошибки, на любом сегменте пути', () => {
    const p = writePlan(NESTED_PLAN)
    expect(parseFrontmatterEntries(p, 'must_haves.такого_нет')).toEqual({ entries: [] })
    expect(parseFrontmatterEntries(p, 'такого_нет.artifacts')).toEqual({ entries: [] })
    expect(parseFrontmatterEntries(p, 'вовсе_нет')).toEqual({ entries: [] })
  })

  it('битый вход отдаёт error или честную пустоту — и НИКОГДА не бросает', () => {
    const missing = parseFrontmatterEntries(join(dir, 'нет-такого-файла-PLAN.md'), 'predictions')
    expect(missing.entries).toEqual([])
    expect(missing.error).toMatch(/cannot read/)

    // Нет открывающей ограды / ограда не закрыта — не ошибка чтения, а «блока нет».
    const noFence = writePlan('# просто заголовок, никакого frontmatter\n', 'no-fence-PLAN.md')
    expect(() => parseFrontmatterEntries(noFence, 'must_haves.key_links')).not.toThrow()
    expect(parseFrontmatterEntries(noFence, 'must_haves.key_links')).toEqual({ entries: [] })

    const unclosed = writePlan('---\nmust_haves:\n  key_links:\n    - from: "a"\n', 'unclosed-PLAN.md')
    expect(() => parseFrontmatterEntries(unclosed, 'must_haves.key_links')).not.toThrow()
    expect(parseFrontmatterEntries(unclosed, 'must_haves.key_links').entries).toEqual([])
  })

  it('запись-строка и запись-объект различимы, и строки — ОПЦИЯ, а не новое умолчание', () => {
    const p = writePlan(NESTED_PLAN)

    // Умолчание: дефис со скаляром закрывает блок — ровно то поведение, на которое
    // опираются четыре старых потребителя. Правка не смеет двигать их числа.
    const asBefore = parseFrontmatterEntries(p, 'must_haves.key_links').entries
    expect(asBefore).toHaveLength(1)
    expect(asBefore.every((e) => typeof e === 'object')).toBe(true)

    // С опцией: проза приходит СТРОКОЙ рядом со структурной записью — на этом различии
    // стоит счёт непроверяемых машиной связей в описи.
    const withProse = parseFrontmatterEntries(p, 'must_haves.key_links', { scalars: true }).entries
    expect(withProse).toHaveLength(2)
    expect(typeof withProse[0]).toBe('object')
    expect(typeof withProse[1]).toBe('string')
    expect(withProse[1]).toBe('связь, написанная прозой — машиной не проверяема')

    const truths = parseFrontmatterEntries(p, 'must_haves.truths', { scalars: true }).entries
    expect(truths).toEqual(['истина словами — читается человеком, не машиной'])
  })
})

// ── «skipped-unsafe» больше не проходит тихо ─────────────────────────────────
//
// Было: план, у которого КАЖДОЕ предсказание отвергнуто границей безопасных
// команд, печатал те же строки, что и здоровый прогон, и выходил с кодом 0.
// Так закрылись две живые фазы: 8 из 8 и 15 из 15 записей — ни одного
// измерения, и это выглядело как «всё в порядке». Настоящая причина у обеих
// одна: хвост «; echo $?» в каждой команде (точка с запятой и доллар не
// проходят SAFE_COMMAND_CHARSET), хотя для кода выхода давно есть поле
// «measure: exit-code».

describe('прибор краснеет, когда мерить нечем', () => {
  it('причина отказа названа словами человека, а не кодом статуса', () => {
    const reason = unsafeCommandReason('pnpm vitest run src/crm/agent-memory; echo $?')
    expect(reason).toContain('точка с запятой')
    expect(reason).toContain('знак доллара')
    // и сразу говорит, чем это пишется правильно — поле, а не хвост команды
    expect(reason).toContain('measure: exit-code')
    expect(reason).not.toContain('skipped-unsafe')

    // «cd X && …» — вторая частая форма, у неё своё поле
    expect(unsafeCommandReason('cd apps/web && pnpm test')).toContain('cwd')

    // разрешённый набор символов, но неразрешённое начало — тоже словами
    expect(unsafeCommandReason('curl example.com')).toContain('начинается не с разрешённого начала')
  })

  it('запись skipped-unsafe несёт причину с собой', () => {
    const p = writePlan(entryYaml({ check_command: '"pnpm vitest run src/x; echo $?"' }), 'PLAN-UNSAFE-REASON.md')
    const runner = vi.fn()
    const { records } = scorePlan({ planPath: p, runCommand: runner })
    expect(runner).not.toHaveBeenCalled()
    expect(records[0].verdict).toBe('skipped-unsafe')
    expect(records[0].unmeasured_reason).toContain('точка с запятой')
  })

  it('прогон, в котором не измерено НИЧЕГО, — красный и объясняет почему', () => {
    const v = measurementVerdict({
      records: [
        { id: 'P1', verdict: 'skipped-unsafe', check_command: 'pnpm vitest run src/x; echo $?' },
        { id: 'P2', verdict: 'skipped-unsafe', unmeasured_reason: 'проверка не запускалась: …' },
      ],
    })
    expect(v.state).toBe('unmeasured')
    expect(v.red).toBe(true)
    expect(v.headline).toContain('НЕ ИЗМЕРЕНО')
    expect(v.lines).toHaveLength(2)
    expect(v.lines[0].reason).toContain('точка с запятой')
  })

  it('одно измерение среди отказов не краснеет — но и не молчит', () => {
    const v = measurementVerdict({
      records: [
        { id: 'P1', verdict: 'hit' },
        { id: 'P2', verdict: 'skipped-unsafe', check_command: 'x | y' },
      ],
    })
    // Гейт не встаёт из-за одной неудачно написанной фразы…
    expect(v.state).toBe('measured')
    expect(v.red).toBe(false)
    // …но отвергнутая запись всё равно предъявлена с причиной.
    expect(v.headline).toContain('ЧАСТЬ НЕ ИЗМЕРЕНА')
    expect(v.lines).toHaveLength(1)
    expect(v.lines[0].id).toBe('P2')
    expect(v.lines[0].reason).toContain('вертикальная черта')
  })

  it('полностью измеренный прогон молчит по делу — заголовка нет', () => {
    const v = measurementVerdict({ records: [{ id: 'P1', verdict: 'hit' }, { id: 'P2', verdict: 'miss' }] })
    expect(v.state).toBe('measured')
    expect(v.headline).toBeNull()
    expect(v.lines).toEqual([])
  })

  it('неприменимость предсказаний сказана вслух, а не спрятана под тем же статусом', () => {
    const none = measurementVerdict({})
    expect(none.state).toBe('not-applicable')
    expect(none.red).toBe(false)
    expect(none.headline).toContain('НЕПРИМЕНИМЫ')

    const receiptsOnly = measurementVerdict({ excluded: [{ id: 'R1', reason: 'receipt' }], receiptsSkipped: 3 })
    expect(receiptsOnly.state).toBe('not-applicable')
    expect(receiptsOnly.headline).toContain('reverify')
    // не тот же текст, что у отказа границы: это разные факты о мире
    expect(receiptsOnly.headline).not.toContain('НЕ ИЗМЕРЕНО:')
  })

  it('ненаступивший срок — не молчание и не краснота', () => {
    const v = measurementVerdict({ notDue: [{ id: 'P1', horizon: '2099-01-01' }] })
    expect(v.state).toBe('registered')
    expect(v.red).toBe(false)
    expect(v.headline).toContain('срок ещё не наступил')
    expect(v.lines[0].reason).toContain('2099-01-01')
  })
})

describe('глагол predict-score: тишина стоит кода выхода 1', () => {
  /** Прогон НАСТОЯЩЕГО глагола настоящим процессом, с изолированным .sma. */
  function runScore(planPath: string): { stdout: string; status: number } {
    const smaRoot = join(dir, '.sma')
    mkdirSync(smaRoot, { recursive: true })
    try {
      const stdout = execFileSync('node', [join(__dirname, '..', 'cli.mjs'), 'predict-score', planPath], {
        encoding: 'utf8',
        env: { ...process.env, SMA_ROOT_OVERRIDE: smaRoot },
      })
      return { stdout, status: 0 }
    } catch (err: any) {
      return { stdout: (err.stdout ?? '').toString(), status: typeof err.status === 'number' ? err.status : 1 }
    }
  }

  it('план, где отвергнуто каждое предсказание, выходит красным и печатает «не измерено» с причиной', () => {
    const p = writePlan(
      entryYaml({ check_command: '"pnpm vitest run src/crm/agent-memory; echo $?"' }) +
        entryYaml({ id: 'P2', check_command: '"pnpm vitest run src/crm/dossier/__tests__/run.test.ts; echo $?"' }),
      'PLAN-ALL-UNSAFE.md',
    )
    const { stdout, status } = runScore(p)
    expect(status).toBe(1)
    expect(stdout).toContain('НЕ ИЗМЕРЕНО')
    expect(stdout).toContain('не измерено · P1: проверка не запускалась')
    expect(stdout).toContain('не измерено · P2:')
    expect(stdout).toContain('точка с запятой')
    expect(stdout).toContain('measure: exit-code')
  })

  it('план без предсказаний говорит о своей неприменимости вслух и остаётся зелёным', () => {
    const p = join(dir, 'PLAN-NOPRED.md')
    writeFileSync(p, '---\nphase: test\n---\n\nтело плана\n')
    const { stdout, status } = runScore(p)
    expect(status).toBe(0)
    expect(stdout).toContain('НЕПРИМЕНИМЫ')
  })
})
