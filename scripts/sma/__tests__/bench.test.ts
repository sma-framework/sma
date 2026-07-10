/**
 * Tests for scripts/sma/lib/bench.mjs (Phase 9.2 Plan 01, Task 1 — the W0 harness).
 *
 * The 8-metric registry + deterministic base readers (S1, S2, S4, S5; registered
 * S6/S8; S3 reads results, S7 reads a persisted base). Everything DI so tests never
 * shell out or touch git.
 *
 *   - Test 1: SCORECARD_METRICS exports EXACTLY 8 entries whose ids match the
 *     scorecard check_commands verbatim, each {id, scorecard:'S1'..'S8', unit, measure}.
 *   - Test 2: every measure returns {metric, value:number, unit, n, method, status}
 *     with status in the honest set; no measure returns a null value or throws.
 *   - Test 3 (S1 blind): false-done-rate counts a failing-artifact plan as false-done
 *     and a clean plan as clean, and NEVER reads a SUMMARY body (blind by construction).
 *   - Test 4 (allowlist): normalizeVerifyCommand unwraps the bash -c "cd X && Y" idiom;
 *     a safe inner runs via the injected runner, an unsafe inner scores skipped-unsafe
 *     with the runner NEVER invoked and the plan counted unverifiable (not false-done).
 *   - Test 5 (S4): measurePhantomWrites flags a claimed file no plan-id commit touched.
 *   - Test 6 (S5): measureTimeToContext medians the markers; n<5 -> insufficient-data;
 *     ratio mode without a frozen base -> pending-instrument.
 *   - Test 7 (S6/S8/S3 honesty): registered slots return value 0 status registered;
 *     compaction-exam with zero graded results returns insufficient-data, never 0-measured.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SCORECARD_METRICS,
  BENCH_STATUS,
  metricById,
  measureFalseDoneRate,
  measureGitLossRecoverability,
  measurePhantomWrites,
  measureTimeToContext,
  measureCompactionExam,
  measureCrossMachineDrill,
  measureCanaryCatch,
  readSelfCostBase,
  normalizeVerifyCommand,
  parseMustHaveArtifacts,
  parseSummaryClaims,
} from '../lib/bench.mjs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-bench-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a fixture PLAN.md with the given must_haves.artifacts + verify commands. */
function writePlan(
  name: string,
  artifacts: { path: string; contains?: string }[],
  verifyCmds: string[] = [],
): string {
  const artLines = artifacts
    .map((a) => `    - path: ${a.path}${a.contains ? `\n      contains: "${a.contains}"` : ''}`)
    .join('\n')
  const verifyBlocks = verifyCmds.map((c) => `<verify>\n  <automated>${c}</automated>\n</verify>`).join('\n')
  const text = `---
phase: 9.1
plan: ${name}
must_haves:
  truths:
    - "a truth"
  artifacts:
${artLines}
---

<tasks>
${verifyBlocks}
</tasks>
`
  const p = join(dir, `9.1-${name}-PLAN.md`)
  writeFileSync(p, text, 'utf8')
  return p
}

describe('bench SCORECARD_METRICS registry (contract)', () => {
  it('Test 1: exports EXACTLY 8 entries whose ids match the scorecard check_commands verbatim', () => {
    const ids = SCORECARD_METRICS.map((m) => m.id)
    expect(ids).toEqual([
      'false-done-rate',
      'airbag-coverage',
      'compaction-exam',
      'phantom-writes',
      'time-to-context-ratio',
      'cross-machine-drill',
      'self-cost',
      'canary-catch',
    ])
    const scorecards = SCORECARD_METRICS.map((m) => m.scorecard)
    expect(scorecards).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])
    for (const m of SCORECARD_METRICS) {
      expect(typeof m.id).toBe('string')
      expect(typeof m.unit).toBe('string')
      expect(typeof m.measure).toBe('function')
    }
    expect(metricById('false-done-rate')).toBe(SCORECARD_METRICS[0])
    expect(metricById('nope')).toBeNull()
  })

  it('Test 2: every measure returns the honest {metric,value,unit,n,method,status} shape, never null/throw', () => {
    for (const m of SCORECARD_METRICS) {
      let out: any
      expect(() => {
        out = m.measure({ dirs: { benchDir: join(dir, 'bench'), journalDir: join(dir, 'journal') } })
      }).not.toThrow()
      expect(out).toBeTruthy()
      expect(typeof out.metric).toBe('string')
      expect(typeof out.value).toBe('number')
      expect(Number.isFinite(out.value)).toBe(true)
      expect(typeof out.unit).toBe('string')
      expect(typeof out.n).toBe('number')
      expect(typeof out.method).toBe('string')
      expect(BENCH_STATUS).toContain(out.status)
    }
  })
})

describe('S1 false-done-rate (blind, claims-only)', () => {
  it('Test 3: a failing-artifact completed plan counts false-done; a clean one counts clean; SUMMARY body NEVER read', () => {
    // a real artifact file the "clean" plan will contains-grep against
    const goodFile = join(dir, 'good.mjs')
    writeFileSync(goodFile, 'export const SCORECARD_METRICS = 8\n', 'utf8')

    const cleanPlan = writePlan('20', [{ path: goodFile, contains: 'SCORECARD_METRICS' }])
    const badPlan = writePlan('21', [{ path: join(dir, 'missing.mjs'), contains: 'NOPE' }])

    // blind existence probe: exists() may be called; readBody() must NEVER be called
    const summaryAccess = { exists: vi.fn(() => true), readBody: vi.fn(() => 'body') }

    const out = measureFalseDoneRate({ planPaths: [cleanPlan, badPlan], summaryAccess })

    expect(out.metric).toBe('false-done-rate')
    expect(out.status).toBe('measured')
    expect(out.n).toBe(2) // both completion-marked
    // exactly one false-done (the bad plan) -> 50%
    expect(out.value).toBe(50)
    const bad = out.detail.find((d: any) => d.plan === badPlan)
    const clean = out.detail.find((d: any) => d.plan === cleanPlan)
    expect(bad.falseDone).toBe(true)
    expect(clean.falseDone).toBe(false)
    // BLIND: the SUMMARY body was never read
    expect(summaryAccess.readBody).not.toHaveBeenCalled()
    expect(summaryAccess.exists).toHaveBeenCalled()
  })

  it('Test 4: normalizeVerifyCommand unwraps bash -c; unsafe inner is skipped-unsafe with the runner never invoked', () => {
    // the standing idiom unwrap
    const norm = normalizeVerifyCommand('bash -c "cd C:/repo && pnpm vitest run scripts/sma/x.test.ts"')
    expect(norm.cwd).toBe('C:/repo')
    expect(norm.inner).toBe('pnpm vitest run scripts/sma/x.test.ts')
    expect(norm.safe).toBe(true)

    const unsafe = normalizeVerifyCommand('bash -c "cd C:/repo && rm -rf /"')
    expect(unsafe.safe).toBe(false)

    // an artifact-clean plan whose ONLY verify command is unsafe -> unverifiable, NOT false-done
    const goodFile = join(dir, 'ok.mjs')
    writeFileSync(goodFile, 'ok symbol\n', 'utf8')
    const plan = writePlan('22', [{ path: goodFile, contains: 'ok' }], ['bash -c "cd C:/repo && rm -rf /"'])

    const runner = vi.fn(() => true)
    const out = measureFalseDoneRate({
      planPaths: [plan],
      runCommand: runner,
      summaryAccess: { exists: () => true },
    })
    expect(runner).not.toHaveBeenCalled() // unsafe command NEVER spawned (T-9.2-01)
    expect(out.unverifiable).toBe(1)
    expect(out.detail[0].falseDone).toBe(false) // unverifiable is not false-done (honest denominator)

    // a SAFE verify command DOES run via the injected runner
    const plan2 = writePlan('23', [{ path: goodFile, contains: 'ok' }], ['node scripts/sma/cli.mjs bench --coverage'])
    const runner2 = vi.fn(() => true)
    measureFalseDoneRate({ planPaths: [plan2], runCommand: runner2, summaryAccess: { exists: () => true } })
    expect(runner2).toHaveBeenCalledTimes(1)

    expect(parseMustHaveArtifacts).toBeTypeOf('function')
  })
})

describe('S2 airbag-coverage / S4 phantom-writes', () => {
  it('Test 5 (S4): a claimed file no plan-id commit touched counts phantom; share/count modes', () => {
    const summaryText = `---
phase: 9.1
plan: 24
key-files:
  created:
    - scripts/sma/lib/real.mjs
    - scripts/sma/lib/phantom.mjs
---
body
`
    const sp = join(dir, '9.1-24-SUMMARY.md')
    writeFileSync(sp, summaryText, 'utf8')
    const parsed = parseSummaryClaims(summaryText)
    expect(parsed.planId).toBe('9.1-24')
    expect(parsed.files).toContain('scripts/sma/lib/real.mjs')

    // gitLog: only real.mjs was actually committed under the plan id
    const gitLog = vi.fn(() => [{ files: ['scripts/sma/lib/real.mjs'] }])
    const count = measurePhantomWrites({ summaryPaths: [sp], gitLog, mode: 'count' })
    expect(count.metric).toBe('phantom-writes')
    expect(count.value).toBe(1) // phantom.mjs is the phantom
    expect(count.n).toBe(2) // two claims
    expect(count.status).toBe('measured')

    const share = measurePhantomWrites({ summaryPaths: [sp], gitLog, mode: 'share' })
    expect(share.value).toBe(50)

    // S2: no destructive firings -> registered, 0
    const s2 = measureGitLossRecoverability({ dirs: { journalDir: join(dir, 'journal') }, journalReader: () => ({ events: [] }) })
    expect(s2.status).toBe('registered')
    expect(s2.value).toBe(0)

    // S2 with a real destructive firing but no snapshot -> measured 0% coverage
    const s2b = measureGitLossRecoverability({
      now: Date.parse('2026-07-08T00:00:00Z'),
      journalReader: () => ({
        events: [{ type: 'gate', ts: '2026-07-07T00:00:00Z', detail: { gateId: 'GATE-CHECKOUT' } }],
      }),
    })
    expect(s2b.status).toBe('measured')
    expect(s2b.n).toBe(1)
    expect(s2b.value).toBe(0)
  })
})

describe('S5 time-to-context', () => {
  it('Test 6: medians the markers; n<5 -> insufficient-data; ratio without a frozen base -> pending-instrument', () => {
    const benchDir = join(dir, 'bench')
    const ttc = join(benchDir, 'ttc')
    mkdirSync(ttc, { recursive: true })
    // 3 markers -> n<5 -> insufficient-data, but the median-so-far is still returned
    const mk = (name: string, deltaMs: number) => {
      const reg = '2026-07-08T00:00:00.000Z'
      const edit = new Date(Date.parse(reg) + deltaMs).toISOString()
      writeFileSync(join(ttc, name), JSON.stringify({ sessionToken: name, registeredAt: reg, firstEditAt: edit }), 'utf8')
    }
    mk('a.json', 1000)
    mk('b.json', 3000)
    mk('c.json', 2000)

    const out = measureTimeToContext({ dirs: { benchDir } })
    expect(out.metric).toBe('time-to-context-ratio')
    expect(out.n).toBe(3)
    expect(out.value).toBe(2000) // median of [1000,2000,3000]
    expect(out.status).toBe('insufficient-data')

    const ratio = measureTimeToContext({ dirs: { benchDir }, mode: 'ratio' })
    expect(ratio.status).toBe('pending-instrument')

    const ratio2 = measureTimeToContext({ dirs: { benchDir }, mode: 'ratio', frozenBase: 6000 })
    expect(ratio2.status).toBe('measured')
    expect(ratio2.value).toBe(3) // 6000 / 2000
  })
})

describe('S6/S8/S3 honesty (registered vs insufficient-data, never fabricated)', () => {
  it('Test 7: registered slots are 0/registered; compaction-exam with zero graded is insufficient-data not 0-measured', () => {
    const s6 = measureCrossMachineDrill()
    expect(s6.value).toBe(0)
    expect(s6.status).toBe('registered')
    expect(s6.method).toMatch(/no mechanism exists/i)

    const s8 = measureCanaryCatch()
    expect(s8.value).toBe(0)
    expect(s8.status).toBe('registered')

    // S3: no results file -> insufficient-data, NOT a fabricated 0-as-measured
    const s3 = measureCompactionExam({ dirs: { benchDir: join(dir, 'bench') } })
    expect(s3.status).toBe('insufficient-data')
    expect(s3.n).toBe(0)

    // S7: no persisted base -> pending-instrument, never a fabricated cost
    const s7 = readSelfCostBase({ dirs: { benchDir: join(dir, 'bench') } })
    expect(s7.status).toBe('pending-instrument')
    expect(s7.value).toBe(0)
  })
})
