/**
 * Tests for scripts/sma/lib/replay-exam.mjs (Phase 9.5 Plan 06, Task 3).
 *
 * D-9.5-08 item 4 — the replay exam. It replays held-out historical founder
 * situations through the synthetic orchestrator and computes a match rate against
 * the founder's real decisions — the calibration metric for the policy prompt.
 *
 *   - Test 1 (export contract): buildExam/scoreExam are functions.
 *   - Test 2 (build + schema): a fixture corpus of founder-decision notes yields
 *     exam-<date>.jsonl (items {id, situation, answerFormat}) + a separate
 *     exam-<date>-key.jsonl under <memoryDir>/exam/.
 *   - Test 3 (determinism): two builds with the SAME seed produce byte-identical
 *     exam + key files (seeded shuffle, no Date.now in the selection path).
 *   - Test 4 (blind-exam invariant): the item file NEVER carries the founder's real
 *     decision / «Почему»; the key file does — the answer is stripped into the key.
 *   - Test 5 (scoring math): 2 match + 1 partial + 1 miss → 62 (floor rounding);
 *     the match rate is the LAST stdout line, an integer; scores.jsonl is appended
 *     with the policy_version.
 *   - Test 6 (malformed tolerance): a malformed grade row is counted + excluded,
 *     never thrown on.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildExam, scoreExam } from '../lib/replay-exam.mjs'

const FIXED_CLOCK = () => '2026-07-14T00:00:00.000Z'

/** A founder-decision corpus note with the three body sections. */
function decisionNote(over: { situation?: string; decision?: string; why?: string; importance?: number } = {}) {
  const situation = over.situation ?? 'контекст до решения'
  const decision = over.decision ?? 'HARD RULE — секреты в репозиторий не коммитим'
  const why = over.why ?? 'потому что секреты утекают'
  return [
    '---',
    'description: Решение основателя: ' + decision,
    'kind: founder-decision',
    'tags: [workflow]',
    'use-when: при похожей ситуации',
    'importance: ' + (over.importance ?? 9),
    'metadata:',
    '  sessionId: s1',
    '  ts: 2026-07-14T10:00:00.000Z',
    '  source: transcripts',
    '---',
    '',
    '## Ситуация (order)',
    '',
    '```untrusted-evidence',
    situation,
    '```',
    '',
    '## Решение основателя',
    '',
    '```untrusted-evidence',
    decision,
    '```',
    '',
    '## Почему',
    '',
    '```untrusted-evidence',
    why,
    '```',
    '',
  ].join('\n')
}

/** Build a memoryDir with N founder-decision notes under drafts/; return its path. */
function mkCorpus(n: number) {
  const dir = mkdtempSync(join(tmpdir(), 'sma-exam-mem-'))
  const drafts = join(dir, 'drafts')
  mkdirSync(drafts, { recursive: true })
  for (let i = 0; i < n; i++) {
    writeFileSync(
      join(drafts, `decision-2026071${i}-item-${i}.md`),
      decisionNote({ situation: `ситуация номер ${i}`, decision: `решение основателя ${i}`, why: `почему ${i}` }),
      'utf8',
    )
  }
  return dir
}

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length) {
    try {
      rmSync(cleanup.pop() as string, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

describe('export contract (Test 1)', () => {
  it('exposes buildExam + scoreExam as functions', () => {
    expect(typeof buildExam).toBe('function')
    expect(typeof scoreExam).toBe('function')
  })
})

describe('buildExam — schema + files (Test 2)', () => {
  it('writes exam-<date>.jsonl (items) + exam-<date>-key.jsonl under <memoryDir>/exam/', () => {
    const mem = mkCorpus(5)
    cleanup.push(mem)

    const res = buildExam({ memoryDir: mem, holdoutPct: 40, seed: 7, clock: FIXED_CLOCK })
    expect(res.count).toBeGreaterThanOrEqual(1)

    const examDir = join(mem, 'exam')
    const files = readdirSync(examDir)
    expect(files).toContain('exam-2026-07-14.jsonl')
    expect(files).toContain('exam-2026-07-14-key.jsonl')

    const itemLines = readFileSync(join(examDir, 'exam-2026-07-14.jsonl'), 'utf8').trim().split('\n')
    const first = JSON.parse(itemLines[0])
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('situation')
    expect(first).toHaveProperty('answerFormat')

    const keyLines = readFileSync(join(examDir, 'exam-2026-07-14-key.jsonl'), 'utf8').trim().split('\n')
    const key = JSON.parse(keyLines[0])
    expect(key).toHaveProperty('id')
    expect(key).toHaveProperty('decision')
    // item count == key count
    expect(itemLines.length).toBe(keyLines.length)
  })
})

describe('buildExam — determinism (Test 3)', () => {
  it('two builds with the same seed produce byte-identical exam + key files', () => {
    const memA = mkCorpus(6)
    const memB = mkCorpus(6)
    cleanup.push(memA, memB)

    buildExam({ memoryDir: memA, holdoutPct: 50, seed: 42, clock: FIXED_CLOCK })
    buildExam({ memoryDir: memB, holdoutPct: 50, seed: 42, clock: FIXED_CLOCK })

    const examA = readFileSync(join(memA, 'exam', 'exam-2026-07-14.jsonl'), 'utf8')
    const examB = readFileSync(join(memB, 'exam', 'exam-2026-07-14.jsonl'), 'utf8')
    expect(examA).toBe(examB)

    const keyA = readFileSync(join(memA, 'exam', 'exam-2026-07-14-key.jsonl'), 'utf8')
    const keyB = readFileSync(join(memB, 'exam', 'exam-2026-07-14-key.jsonl'), 'utf8')
    expect(keyA).toBe(keyB)
  })
})

describe('buildExam — blind-exam invariant (Test 4)', () => {
  it('the item file never carries the real decision; the key file does', () => {
    const mem = mkdtempSync(join(tmpdir(), 'sma-exam-mem-'))
    const drafts = join(mem, 'drafts')
    mkdirSync(drafts, { recursive: true })
    const SECRET_DECISION = 'НИКОГДА-НЕ-ПОКАЗЫВАЙ-ЭКЗАМЕНУЕМОМУ-999'
    writeFileSync(
      join(drafts, 'decision-20260714-blind.md'),
      decisionNote({ situation: 'видимая ситуация', decision: SECRET_DECISION, why: 'скрытое почему 999' }),
      'utf8',
    )
    cleanup.push(mem)

    buildExam({ memoryDir: mem, holdoutPct: 100, seed: 1, clock: FIXED_CLOCK })
    const examDir = join(mem, 'exam')
    const itemText = readFileSync(join(examDir, 'exam-2026-07-14.jsonl'), 'utf8')
    const keyText = readFileSync(join(examDir, 'exam-2026-07-14-key.jsonl'), 'utf8')

    expect(itemText).not.toContain(SECRET_DECISION)
    expect(itemText).not.toContain('скрытое почему 999')
    expect(itemText).toContain('видимая ситуация')
    expect(keyText).toContain(SECRET_DECISION)
  })
})

describe('scoreExam — math + numeric-last-line (Test 5)', () => {
  it('2 match + 1 partial + 1 miss → 62 (floor), printed as the last line, scored to ledger', () => {
    const mem = mkdtempSync(join(tmpdir(), 'sma-exam-mem-'))
    mkdirSync(join(mem, 'exam'), { recursive: true })
    const gradesPath = join(mem, 'grades.jsonl')
    writeFileSync(
      gradesPath,
      [
        JSON.stringify({ id: 'a', verdict: 'match' }),
        JSON.stringify({ id: 'b', verdict: 'match' }),
        JSON.stringify({ id: 'c', verdict: 'partial' }),
        JSON.stringify({ id: 'd', verdict: 'miss' }),
      ].join('\n'),
      'utf8',
    )
    cleanup.push(mem)

    const out: string[] = []
    const res = scoreExam({
      gradesPath,
      memoryDir: mem,
      policyVersion: 1,
      clock: FIXED_CLOCK,
      out: (s: string) => out.push(s),
    })
    // (2 + 0.5*1) / 4 * 100 = 62.5 -> floor 62
    expect(res.matchRate).toBe(62)
    expect(res.total).toBe(4)

    const printed = out.join('').trim().split('\n')
    expect(printed[printed.length - 1]).toBe('62')

    // scores.jsonl appended with the policy_version
    const scoresPath = join(mem, 'exam', 'scores.jsonl')
    expect(existsSync(scoresPath)).toBe(true)
    const row = JSON.parse(readFileSync(scoresPath, 'utf8').trim().split('\n').pop() as string)
    expect(row.matchRate).toBe(62)
    expect(row.policyVersion).toBe(1)
  })
})

describe('scoreExam — malformed tolerance (Test 6)', () => {
  it('counts + excludes a malformed grade row, never throws', () => {
    const mem = mkdtempSync(join(tmpdir(), 'sma-exam-mem-'))
    mkdirSync(join(mem, 'exam'), { recursive: true })
    const gradesPath = join(mem, 'grades.jsonl')
    writeFileSync(
      gradesPath,
      [
        JSON.stringify({ id: 'a', verdict: 'match' }),
        '{ not valid json',
        JSON.stringify({ id: 'b', verdict: 'nonsense-verdict' }),
        JSON.stringify({ id: 'c', verdict: 'miss' }),
      ].join('\n'),
      'utf8',
    )
    cleanup.push(mem)

    const res = scoreExam({ gradesPath, memoryDir: mem, out: () => {} })
    expect(res.malformed).toBeGreaterThanOrEqual(2)
    // valid rows: a(match) + c(miss) = 1/2 -> 50
    expect(res.total).toBe(2)
    expect(res.matchRate).toBe(50)
  })
})
