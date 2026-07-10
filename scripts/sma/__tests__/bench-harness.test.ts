/**
 * Tests for scripts/sma/lib/bench.mjs harness (Phase 49.2 Plan 01, Task 2).
 *
 * The A/B throwaway-clone replay + hook timing (S7), the compaction exam (S3), and
 * the ttc first-edit recorder (S5 instrument). Everything DI (injected exec/hrtime/
 * writers) so tests are instant, deterministic, and never shell out or touch git.
 *
 *   - Test 1 (clone isolation): abRun clones the source ONLY (read-class) into two
 *     mkdtemp roots; every hook spawn runs with cwd under a clone, never the source.
 *   - Test 2 (A/B delta, hurts included): the report carries per-hook p50/p95 +
 *     spawns-per-tool-call; a planted slow hook lands in the `hurts` array.
 *   - Test 3 (self-cost base): measureSelfCost aggregates replay timing into S7's
 *     ms-per-tool-call base shape, status measured.
 *   - Test 4 (exam determinism): examNew produces the SAME key twice; examGrade does
 *     normalized keyword matching and appends ONE JSONL result line.
 *   - Test 5 (recorder fail-open): recordFirstEdit writes ONE marker on the first
 *     Edit, no-ops on the second, and never throws on bad input.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  abRun,
  measureSelfCost,
  measureCompactionExam,
  examNew,
  examGrade,
  buildAnswerKey,
  recordFirstEdit,
  HOOK_BUDGET_MS,
} from '../lib/bench.mjs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-benchh-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A small fixture session: 1 session-start + 2 tool calls (3 pre + 1 post each). */
function fixtureEvents() {
  const sid = 'sess-1'
  const evs: any[] = [{ hook: 'session-start', stdinPayload: { session_id: sid } }]
  for (let i = 0; i < 2; i++) {
    for (const h of ['collision-check', 'reflex-check', 'gates-check']) {
      evs.push({ hook: h, toolName: 'Edit', stdinPayload: { session_id: sid, tool_name: 'Edit', tool_input: { file_path: `f${i}.ts` } } })
    }
    evs.push({ hook: 'stall-check', toolName: 'Edit', stdinPayload: { session_id: sid, tool_response: { success: true } } })
  }
  return evs
}

describe('A/B replay (S7)', () => {
  it('Test 1: clones the SOURCE only (read-class); every hook spawn cwd is under a mkdtemp clone, never src', () => {
    const srcRoot = join(dir, 'src-repo')
    const withDir = join(dir, 'with')
    const withoutDir = join(dir, 'without')
    let call = 0
    const mkdtempFn = () => (call++ === 0 ? withDir : withoutDir)

    let clock = 0
    const hrtime = () => clock
    const exec = vi.fn((_bin: string, _args: string[]) => {
      clock += 10
      return { stdout: '' }
    })

    const report = abRun({ srcRoot, fixture: fixtureEvents(), exec, hrtime, mkdtempFn })

    // the source is referenced ONLY as the clone source (read-class), twice
    const cloneCalls = exec.mock.calls.filter((c) => c[1][0] === 'clone')
    expect(cloneCalls.length).toBe(2)
    for (const c of cloneCalls) {
      expect(c[1]).toContain('--local')
      expect(c[1]).toContain(srcRoot) // src is the SOURCE arg
      expect(c[1][c[1].length - 1]).toMatch(/with|without/) // dest is a mkdtemp clone
    }
    // every NON-clone call (hook spawn) runs with cwd under the `with` clone, never src
    const spawnCalls = exec.mock.calls.filter((c) => c[1][0] !== 'clone')
    expect(spawnCalls.length).toBeGreaterThan(0)
    for (const c of spawnCalls) {
      const opts = c[2] || {}
      expect(opts.cwd).toBe(withDir)
      expect(opts.cwd).not.toBe(srcRoot)
    }
    expect(report.toolCalls).toBe(2)
  })

  it('Test 2: report carries per-hook p50/p95 + spawns-per-tool-call; a planted slow hook lands in hurts', () => {
    const srcRoot = join(dir, 'src')
    let call = 0
    const mkdtempFn = () => join(dir, call++ === 0 ? 'with' : 'without')
    let clock = 0
    const hrtime = () => clock
    // plant a slow gates-check (> budget); others cheap
    const exec = vi.fn((_bin: string, args: string[]) => {
      const hook = args[1]
      if (args[0] === 'clone') {
        clock += 1
      } else {
        clock += hook === 'gates-check' ? HOOK_BUDGET_MS + 100 : 5
      }
      return { stdout: '' }
    })

    const report = abRun({ srcRoot, fixture: fixtureEvents(), exec, hrtime, mkdtempFn })

    expect(report.perHook['collision-check']).toBeTruthy()
    expect(typeof report.perHook['collision-check'].p50).toBe('number')
    expect(typeof report.perHook['collision-check'].p95).toBe('number')
    expect(report.spawnsPerToolCall).toBe(4) // 3 pre + 1 post
    const slow = report.hurts.find((h: any) => h.hook === 'gates-check' && h.reason === 'p95-over-budget')
    expect(slow).toBeTruthy()
    expect(slow.p95).toBeGreaterThan(HOOK_BUDGET_MS)
  })

  it('Test 3: measureSelfCost aggregates replay timing into S7 ms-per-tool-call base', () => {
    let clock = 0
    const hrtime = () => clock
    const exec = vi.fn(() => {
      clock += 5 // each spawn costs 5ms
      return { stdout: '' }
    })
    const benchDir = join(dir, 'bench')
    const out = measureSelfCost({ fixture: fixtureEvents(), exec, hrtime, dirs: { benchDir }, now: Date.parse('2026-07-08T00:00:00Z') })

    expect(out.metric).toBe('self-cost')
    expect(out.unit).toBe('ms-per-tool-call')
    expect(out.status).toBe('measured')
    expect(out.n).toBe(2) // two tool calls
    // 2 tool calls * 4 spawns * 5ms = 40ms total / 2 = 20 ms per tool call
    expect(out.value).toBe(20)
    expect(out.method).toMatch(/spend-share instrument arrives plan 09/)
    // persisted so readSelfCostBase / bench --json can surface it
    expect(existsSync(join(benchDir, 'selfcost.json'))).toBe(true)
  })
})

describe('compaction exam (S3)', () => {
  it('Test 4: examNew is deterministic; examGrade keyword-matches and appends ONE result line', () => {
    const benchDir = join(dir, 'bench')
    const state = {
      activePlan: '49.2-01',
      nextTask: 'task 2',
      filesModified: ['scripts/sma/lib/bench.mjs'],
      claims: ['bench-49.2-01'],
      journalTail: ['claim bench', 'gate GATE-CHECKOUT'],
      gates: ['GATE-PUSH'],
      nextMigration: '046',
      phaseWave: '49.2 wave 0',
      lockedDecisions: ['D-49.2-02'],
      predictions: ['P49.2-01-A threshold 8'],
    }
    const now = '2026-07-08T00:00:00.000Z'
    const a = examNew({ dirs: { benchDir }, state, now })
    const b = examNew({ dirs: { benchDir }, state, now })
    // deterministic: same state + ts -> byte-identical key questions
    expect(JSON.stringify(a.key.questions)).toBe(JSON.stringify(b.key.questions))
    expect(a.key.questions.length).toBe(10)

    // a correct-ish answer sheet: include the key phrases for Q1 and Q8
    const answers: Record<string, string> = {}
    for (const q of a.key.questions) answers[q.q] = q.answer // perfect answers -> 100%
    const perfect = examGrade({ key: a.key, answers, dirs: { benchDir }, now: Date.parse(now) })
    expect(perfect.score).toBe(100)

    // a wrong sheet -> lower score
    const wrong = examGrade({ key: a.key, answers: { Q1: 'nonsense' }, dirs: { benchDir }, now: Date.parse(now) })
    expect(wrong.score).toBeLessThan(100)

    // two grades appended -> results.jsonl has 2 lines, and S3 now reads them
    const results = readFileSync(join(benchDir, 'exam', 'results.jsonl'), 'utf8').trim().split('\n')
    expect(results.length).toBe(2)
    const s3 = measureCompactionExam({ dirs: { benchDir } })
    expect(s3.n).toBe(2)
    // still insufficient-data (needs >=3) — honest
    expect(s3.status).toBe('insufficient-data')

    expect(buildAnswerKey({}).length).toBe(10)
  })
})

describe('ttc first-edit recorder (S5)', () => {
  it('Test 5: writes ONE marker on the first Edit, no-ops on the second, never throws', () => {
    const benchDir = join(dir, 'bench')
    const r1 = recordFirstEdit({ toolName: 'Edit', sessionToken: 'sess-x', dirs: { benchDir }, registeredAt: '2026-07-08T00:00:00.000Z', now: Date.parse('2026-07-08T00:00:05.000Z') })
    expect(r1.written).toBe(true)
    const marker = JSON.parse(readFileSync(r1.path!, 'utf8'))
    expect(marker.sessionToken).toBe('sess-x')
    expect(marker.registeredAt).toBe('2026-07-08T00:00:00.000Z')
    expect(marker.firstEditAt).toBe('2026-07-08T00:00:05.000Z')

    // second Edit -> no-op (marker already exists), no rewrite
    const r2 = recordFirstEdit({ toolName: 'Edit', sessionToken: 'sess-x', dirs: { benchDir }, now: Date.parse('2026-07-08T00:00:09.000Z') })
    expect(r2.written).toBe(false)
    const still = JSON.parse(readFileSync(r1.path!, 'utf8'))
    expect(still.firstEditAt).toBe('2026-07-08T00:00:05.000Z') // unchanged

    // a non-Edit tool records nothing
    expect(recordFirstEdit({ toolName: 'Bash', sessionToken: 'sess-y', dirs: { benchDir } }).written).toBe(false)

    // bad input never throws (fail-open)
    expect(() => recordFirstEdit({} as any)).not.toThrow()
    expect(recordFirstEdit({} as any).written).toBe(false)

    // one ttc marker file exists for sess-x
    const files = readdirSync(join(benchDir, 'ttc'))
    expect(files.filter((f) => f.startsWith('sess-x')).length).toBe(1)
  })
})
