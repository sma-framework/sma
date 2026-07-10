/**
 * Tests for scripts/sma/lib/stall.mjs (Phase 9.1 Plan 21, Task 1 — B16 sibling).
 *
 * Rule-based stall detection (OpenHands StuckDetector doctrine — deterministic
 * thresholds, NEVER LLM-judged; RESEARCH Anti-pattern A1) over a rolling
 * PostToolUse window persisted per session in .sma/stall/<session>.json.
 *
 *   - Test 1: 4 consecutive identical tool calls (same tool+input hash) ->
 *     'same-action-repeat'; 3 do NOT detect.
 *   - Test 2: 3 consecutive events whose error output matches after
 *     normalization (digits/line-numbers stripped) -> 'same-error-repeat'.
 *   - Test 3: A-B-A-B edit alternation on two files (2 full cycles) ->
 *     'ping-pong'.
 *   - Test 4: a healthy-progress fixture (varied tools, green test output) ->
 *     NO detection across all rules (the anti-fatigue case).
 *   - Test 5: the window is rolling (old events age out by count, bounded at
 *     WINDOW_SIZE) and per-session (two tokens -> two files);
 *     SMA_STALL_DISABLE=1 silences both recordEvent and detect.
 *
 * Thresholds are asserted as EXPORTED constants — no magic numbers in detect().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  recordEvent,
  detect,
  formatNudge,
  SAME_ACTION_REPEAT,
  SAME_ERROR_REPEAT,
  PINGPONG_CYCLES,
  MONOLOGUE_TURNS,
  WINDOW_SIZE,
} from '../lib/stall.mjs'

let stallDir: string

beforeEach(() => {
  stallDir = mkdtempSync(join(tmpdir(), 'sma-stall-'))
})

afterEach(() => {
  rmSync(stallDir, { recursive: true, force: true })
})

/** Synthetic PostToolUse hook payloads (real shape: tool_name/tool_input/tool_response). */
function editEvt(file: string, newString = 'x') {
  return {
    session_id: 'sess-a',
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'a', new_string: newString },
    tool_response: {},
  }
}

function bashEvt(cmd: string, resp: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-a',
    tool_name: 'Bash',
    tool_input: { command: cmd },
    tool_response: resp,
  }
}

function record(evt: object, sessionToken = 'sess-a', env: Record<string, string> = {}) {
  return recordEvent(evt, { stallDir, sessionToken, env })
}

describe('stall.mjs — exported thresholds', () => {
  it('exposes the rule thresholds as constants (no magic numbers)', () => {
    expect(SAME_ACTION_REPEAT).toBe(4)
    expect(SAME_ERROR_REPEAT).toBe(3)
    expect(PINGPONG_CYCLES).toBe(2)
    expect(MONOLOGUE_TURNS).toBeGreaterThan(0)
    expect(WINDOW_SIZE).toBe(20)
  })
})

describe('Test 1 — same-action-repeat', () => {
  it('detects after 4 identical tool calls, not after 3', () => {
    const evt = bashEvt('pnpm vitest run scripts/sma/__tests__/x.test.ts')
    let window: unknown[] = []
    for (let i = 0; i < SAME_ACTION_REPEAT - 1; i++) window = record(evt)
    expect(detect(window)).toBeNull() // 3 repeats -> no detection

    window = record(evt) // 4th identical call
    const hit = detect(window)
    expect(hit).not.toBeNull()
    expect(hit!.pattern).toBe('same-action-repeat')
  })

  it('does not detect 4 varied calls to the same tool', () => {
    let window: unknown[] = []
    for (let i = 0; i < SAME_ACTION_REPEAT; i++) window = record(bashEvt(`echo ${i}`))
    expect(detect(window)).toBeNull()
  })
})

describe('Test 2 — same-error-repeat', () => {
  it('detects 3 consecutive normalized-identical errors (line numbers differ)', () => {
    let window: unknown[] = []
    window = record(bashEvt('pnpm vitest run a', { stderr: 'Error: ENOENT src/foo.ts:123' }))
    window = record(bashEvt('pnpm vitest run b', { stderr: 'Error: ENOENT src/foo.ts:456' }))
    expect(detect(window)).toBeNull() // 2 repeats -> not yet

    window = record(bashEvt('pnpm vitest run c', { stderr: 'Error: ENOENT src/foo.ts:789' }))
    const hit = detect(window)
    expect(hit).not.toBeNull()
    expect(hit!.pattern).toBe('same-error-repeat')
  })

  it('does not detect 3 consecutive DIFFERENT errors', () => {
    let window: unknown[] = []
    window = record(bashEvt('cmd a', { stderr: 'Error: ENOENT foo.ts' }))
    window = record(bashEvt('cmd b', { stderr: 'TypeError: x is not a function' }))
    window = record(bashEvt('cmd c', { stderr: 'SyntaxError: unexpected token' }))
    expect(detect(window)).toBeNull()
  })
})

describe('Test 3 — ping-pong', () => {
  it('detects A-B-A-B edit alternation over 2 full cycles', () => {
    let window: unknown[] = []
    for (let cycle = 0; cycle < PINGPONG_CYCLES; cycle++) {
      window = record(editEvt('C:\\proj\\src\\a.ts', `edit-a-${cycle}`))
      window = record(editEvt('C:\\proj\\src\\b.ts', `edit-b-${cycle}`))
    }
    const hit = detect(window)
    expect(hit).not.toBeNull()
    expect(hit!.pattern).toBe('ping-pong')
  })

  it('does not detect edits alternating across THREE files', () => {
    let window: unknown[] = []
    window = record(editEvt('C:\\proj\\a.ts', '1'))
    window = record(editEvt('C:\\proj\\b.ts', '2'))
    window = record(editEvt('C:\\proj\\c.ts', '3'))
    window = record(editEvt('C:\\proj\\a.ts', '4'))
    expect(detect(window)).toBeNull()
  })
})

describe('Test 4 — healthy-progress fixture (anti-fatigue negative)', () => {
  it('never detects on a varied, green sequence', () => {
    const healthy = [
      editEvt('C:\\proj\\src\\feature.ts', 'implement step 1'),
      bashEvt('pnpm vitest run scripts/sma/__tests__/feature.test.ts', {
        stdout: 'Test Files  1 passed (1)\nTests  5 passed (5)',
      }),
      editEvt('C:\\proj\\src\\other.ts', 'implement step 2'),
      bashEvt('git status --porcelain', { stdout: ' M src/feature.ts' }),
      editEvt('C:\\proj\\src\\feature.ts', 'refine step 1'),
      bashEvt('git add src/feature.ts', { stdout: '' }),
      bashEvt('git commit -m "feat: step"', { stdout: '1 file changed' }),
    ]
    let window: unknown[] = []
    for (const evt of healthy) {
      window = record(evt)
      expect(detect(window)).toBeNull() // no rule fires at ANY point
    }
  })
})

describe('Test 5 — rolling window, per-session state, kill-switch', () => {
  it('bounds the stored window at WINDOW_SIZE (old events age out by count)', () => {
    let window: unknown[] = []
    for (let i = 0; i < WINDOW_SIZE + 10; i++) window = record(bashEvt(`echo unique-${i}`))
    expect(window.length).toBeLessThanOrEqual(WINDOW_SIZE)

    const files = readdirSync(stallDir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBe(1)
    const stored = JSON.parse(readFileSync(join(stallDir, files[0]), 'utf8'))
    expect(stored.events.length).toBeLessThanOrEqual(WINDOW_SIZE)
  })

  it('keeps sessions separate (two tokens -> two files, independent windows)', () => {
    const evt = bashEvt('pnpm vitest run x')
    for (let i = 0; i < SAME_ACTION_REPEAT; i++) record(evt, 'sess-one')
    const other = record(evt, 'sess-two') // 1 event only in this session
    expect(other.length).toBe(1)
    expect(detect(other)).toBeNull()
    expect(existsSync(join(stallDir, 'sess-one.json'))).toBe(true)
    expect(existsSync(join(stallDir, 'sess-two.json'))).toBe(true)
  })

  it('SMA_STALL_DISABLE=1 silences recordEvent and detect', () => {
    const env = { SMA_STALL_DISABLE: '1' }
    let window: unknown[] = []
    for (let i = 0; i < SAME_ACTION_REPEAT; i++) {
      window = record(bashEvt('same command'), 'sess-a', env)
    }
    expect(window).toEqual([]) // nothing recorded
    expect(readdirSync(stallDir).filter((f) => f.endsWith('.json')).length).toBe(0)

    // detect is silenced under the kill-switch even over a pre-built window
    let real: unknown[] = []
    for (let i = 0; i < SAME_ACTION_REPEAT; i++) real = record(bashEvt('same command'))
    expect(detect(real)).not.toBeNull()
    expect(detect(real, { env })).toBeNull()
  })
})

describe('formatNudge — advisory text names the pattern + a break action', () => {
  it('names the detected pattern and suggests a way out', () => {
    const evt = bashEvt('pnpm vitest run x')
    let window: unknown[] = []
    for (let i = 0; i < SAME_ACTION_REPEAT; i++) window = record(evt)
    const hit = detect(window)
    const text = formatNudge(hit!)
    expect(text).toContain('same-action-repeat')
    expect(text.length).toBeGreaterThan(20)
  })
})

describe('monologue rule — guarded on payload turn info (A4 spike)', () => {
  it('fires only when the payload exposes a tool-less-turns field; inert otherwise', () => {
    // Inert: a normal payload has no turn info -> never 'monologue'.
    let window: unknown[] = []
    window = record(bashEvt('echo hi'))
    expect(detect(window)).toBeNull()

    // Guarded activation: if the hook ever delivers turns_without_tools, the rule works.
    const evt = {
      session_id: 'sess-a',
      tool_name: 'Bash',
      tool_input: { command: 'echo back-to-work' },
      tool_response: {},
      turns_without_tools: MONOLOGUE_TURNS,
    }
    window = record(evt)
    const hit = detect(window)
    expect(hit).not.toBeNull()
    expect(hit!.pattern).toBe('monologue')
  })
})
