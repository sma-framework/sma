/**
 * Tests for tools/terminal-parity-check.mjs — the five receipts of terminal parity.
 *
 * THE SHAPE OF THIS SUITE IS THE POINT (repudiation mitigation): a checker that only ever
 * sees a complete run proves nothing, because a checker that always prints 5/5 would pass
 * that test too. So every receipt gets a fixture in which EXACTLY ONE artifact is missing,
 * and the suite asserts that THAT receipt — and only that one — fails, and that the run's
 * exit code stops being 0. Fixtures live in an injected in-memory fs: no disk, no spawn.
 *
 *   - Test 1:  a complete run scores 5/5, exit 0, and the last line is the bare number.
 *   - Test 2:  no guard log → the guards receipt fails (hooks unproven), exit != 0.
 *   - Test 3:  a guard log whose entries fall OUTSIDE the run window → still a failure
 *              (the window is what makes it a receipt of THIS run).
 *   - Test 4:  no corpus touch → the memory receipt fails.
 *   - Test 5:  the task prompt naming the memory index does NOT certify a read — the
 *              instruction is not the receipt (the self-certifying loop, refused).
 *   - Test 6:  the attempt journal's memory layer is the accepted second source.
 *   - Test 7:  a skills-bearing worker with no Skill invocation → the skill receipt fails.
 *   - Test 8:  a worker with NO skills → skill is n/a, honestly counted, run still 5/5.
 *   - Test 9:  no reverify receipt → the receipt receipt fails; a malformed one too.
 *   - Test 10: no worker profile → the profile receipt fails.
 *   - Test 11: a model substitution (profile sonnet, args opus) → the profile receipt fails.
 *   - Test 12: no arguments → usage on stderr, a NON-ZERO exit, nothing claimed on stdout.
 */

import { describe, it, expect } from 'vitest'

import { buildClaudeArgs } from '../src/runner/args.mjs'
import {
  runCheck,
  evaluate,
  formatReport,
  PARITY_RECEIPTS,
  PARITY_RECEIPT_COUNT,
  USAGE,
} from '../../tools/terminal-parity-check.mjs'

const DIR = '/run'
const CONFIG = '/cfg/config.json'
const LEDGER = '/ledger'

const STARTED = '2026-08-01T10:00:00.000Z'
const ENDED = '2026-08-01T10:20:00.000Z'

/** An in-memory fs with OS-agnostic keys (join() yields backslashes on win32). */
function fakeFs(files: Record<string, string>) {
  const norm = (p: string) => String(p).replace(/\\/g, '/')
  const table = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]))
  return {
    existsSync: (p: string) => table.has(norm(p)),
    readFileSync: (p: string) => {
      const key = norm(p)
      if (!table.has(key)) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' })
      return table.get(key) as string
    },
  }
}

const jsonl = (rows: any[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

/** The task prompt as it reaches the transcript: it NAMES the memory index (test 5's trap). */
const promptEntry = {
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Перед первым действием прочитайте индекс памяти `.claude/memory/MEMORY.md`' }],
  },
}

const readMemoryEntry = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/wt/BL-301/.claude/memory/MEMORY.md' } }],
  },
}

const skillEntry = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'sma-debug' } }],
  },
}

const RUN = {
  attemptId: 'BL-301#1',
  taskId: 'BL-301',
  attempt: 1,
  workerId: 'max-1',
  startedAt: STARTED,
  endedAt: ENDED,
  args: buildClaudeArgs({ model: 'sonnet', effort: 'high', addDir: '/wt/BL-301' }),
}

const RECEIPT = {
  id: 'R-parity-1',
  assertion: 'целевой сьют зелёный',
  check_command: 'node tools/verify-rebrand.mjs',
  expected_sha256: 'a'.repeat(64),
}

const CONFIG_JSON = {
  workers: [
    { id: 'max-1', lane: 'prod', provider: 'claude', model: 'sonnet', effort: 'high', skills: ['sma-debug'] },
  ],
}

/** The complete run: every artifact present, every receipt earnable. */
function fullFiles(over: Record<string, any> = {}) {
  const files: Record<string, string> = {
    [`${DIR}/run.json`]: JSON.stringify(RUN),
    [`${DIR}/guards.jsonl`]: jsonl([
      { ts: '2026-08-01T10:00:05.000Z', type: 'hook', detail: 'PreToolUse' },
      { ts: '2026-08-01T10:12:00.000Z', type: 'hook', detail: 'PostToolUse' },
    ]),
    [`${DIR}/transcript.jsonl`]: jsonl([promptEntry, readMemoryEntry, skillEntry]),
    [`${DIR}/receipt.json`]: JSON.stringify(RECEIPT),
    [CONFIG]: JSON.stringify(CONFIG_JSON),
  }
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete files[k]
    else files[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return files
}

/** Drive the real CLI entry point over a fixture; return {code, out, errOut}. */
function run(files: Record<string, string>, argv: string[] = ['BL-301#1', '--dir', DIR, '--config', CONFIG]) {
  const out: string[] = []
  const errOut: string[] = []
  const code = runCheck(argv, {
    fsImpl: fakeFs(files),
    log: (l: string) => out.push(String(l)),
    err: (l: string) => errOut.push(String(l)),
    cwd: '/repo',
  })
  return { code, out, errOut, last: out[out.length - 1], line: (id: string) => out[PARITY_RECEIPTS.findIndex((r) => r.id === id)] }
}

describe('terminal-parity-check — a complete run', () => {
  it('scores 5/5, exits 0, and ends on the bare number', () => {
    const r = run(fullFiles())
    expect(r.out).toHaveLength(PARITY_RECEIPT_COUNT + 1)
    for (const { id } of PARITY_RECEIPTS) expect(r.line(id)).toMatch(/^OK — /)
    expect(r.last).toBe('5')
    expect(Number.isFinite(Number(r.last))).toBe(true) // receipt-hash / scorer contract
    expect(r.code).toBe(0)
  })
})

describe('terminal-parity-check — every receipt has its own absence', () => {
  it('(a) no guard log → the guards receipt fails and the run is no longer green', () => {
    const r = run(fullFiles({ [`${DIR}/guards.jsonl`]: null }))
    expect(r.line('guards')).toMatch(/^FAIL — /)
    expect(r.last).toBe('4')
    expect(r.code).not.toBe(0)
  })

  it('(a) guard entries OUTSIDE the run window do not count — the window is the receipt', () => {
    const r = run(
      fullFiles({
        [`${DIR}/guards.jsonl`]: jsonl([{ ts: '2026-07-31T09:00:00.000Z', type: 'hook' }]),
      }),
    )
    expect(r.line('guards')).toMatch(/^FAIL — /)
    expect(r.code).not.toBe(0)
  })

  it('(b) no corpus touch → the memory receipt fails', () => {
    const r = run(fullFiles({ [`${DIR}/transcript.jsonl`]: jsonl([promptEntry, skillEntry]) }))
    expect(r.line('memory')).toMatch(/^FAIL — /)
    expect(r.last).toBe('4')
    expect(r.code).not.toBe(0)
  })

  it('(b) the PROMPT naming the memory index certifies nothing — the instruction is not the read', () => {
    // the transcript carries the directive verbatim (a text search would score it OK) and a
    // tool call that touches something else entirely.
    const decoy = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/wt/BL-301/src/index.ts' } }],
      },
    }
    const r = run(fullFiles({ [`${DIR}/transcript.jsonl`]: jsonl([promptEntry, decoy, skillEntry]) }))
    expect(r.line('memory')).toMatch(/^FAIL — /)
  })

  it('(b) the attempt journal memory layer is the accepted second source', () => {
    const files = fullFiles({ [`${DIR}/transcript.jsonl`]: jsonl([promptEntry, skillEntry]) })
    files[`${LEDGER}/BL-301.journal.jsonl`] = jsonl([
      { taskId: 'BL-301', attempt: 1, attemptId: 'BL-301#1', layer: 'memory', payload: { notes: ['role.md'], reflexes: [] } },
    ])
    const r = run(files, ['BL-301#1', '--dir', DIR, '--config', CONFIG, '--ledger', LEDGER])
    expect(r.line('memory')).toMatch(/^OK — /)
    expect(r.last).toBe('5')
    expect(r.code).toBe(0)
  })

  it('(c) a skills-bearing worker with no Skill invocation → the skill receipt fails', () => {
    const r = run(fullFiles({ [`${DIR}/transcript.jsonl`]: jsonl([promptEntry, readMemoryEntry]) }))
    expect(r.line('skill')).toMatch(/^FAIL — /)
    expect(r.last).toBe('4')
    expect(r.code).not.toBe(0)
  })

  it('(c) a worker with NO skills → n/a, counted honestly, the run stays complete', () => {
    const r = run(
      fullFiles({
        [`${DIR}/transcript.jsonl`]: jsonl([promptEntry, readMemoryEntry]),
        [CONFIG]: { workers: [{ id: 'max-1', lane: 'prod', model: 'sonnet', effort: 'high' }] },
      }),
    )
    expect(r.line('skill')).toMatch(/^n-a — /)
    expect(r.line('skill')).toMatch(/нетриггерная/)
    expect(r.last).toBe('5')
    expect(r.code).toBe(0)
  })

  it('(d) no reverify receipt → the receipt receipt fails; a malformed one fails too', () => {
    const missing = run(fullFiles({ [`${DIR}/receipt.json`]: null }))
    expect(missing.line('receipt')).toMatch(/^FAIL — /)
    expect(missing.code).not.toBe(0)

    const malformed = run(fullFiles({ [`${DIR}/receipt.json`]: '{not json' }))
    expect(malformed.line('receipt')).toMatch(/^FAIL — /)

    const schemaBad = run(fullFiles({ [`${DIR}/receipt.json`]: { id: 'R', expected_sha256: 'short' } }))
    expect(schemaBad.line('receipt')).toMatch(/^FAIL — /)
  })

  it('(e) no worker profile in the config → the profile receipt fails, and skill cannot claim n/a', () => {
    const r = run(fullFiles({ [CONFIG]: { workers: [{ id: 'other', lane: 'prod' }] } }))
    expect(r.line('profile')).toMatch(/^FAIL — /)
    // an ABSENT profile is ignorance, not «a worker with no skills»: it must not launder
    // itself into a free n/a, so it sinks BOTH receipts that read the profile.
    expect(r.line('skill')).toMatch(/^FAIL — /)
    expect(r.last).toBe('3')
    expect(r.code).not.toBe(0)
  })

  it('(e) a model substitution (profile sonnet, spawn opus) → the profile receipt fails', () => {
    const r = run(
      fullFiles({
        [`${DIR}/run.json`]: { ...RUN, args: buildClaudeArgs({ model: 'opus', effort: 'high' }) },
      }),
    )
    expect(r.line('profile')).toMatch(/^FAIL — /)
    expect(r.line('profile')).toMatch(/opus/)
    expect(r.code).not.toBe(0)
  })
})

describe('terminal-parity-check — the command contract', () => {
  it('no arguments → usage on stderr and a NON-ZERO exit (never a quiet success)', () => {
    const out: string[] = []
    const errOut: string[] = []
    const code = runCheck([], { log: (l: string) => out.push(l), err: (l: string) => errOut.push(l) })
    expect(code).not.toBe(0)
    expect(out).toHaveLength(0) // nothing is claimed when nothing was measured
    expect(errOut.join('\n')).toContain('usage: node tools/terminal-parity-check.mjs')
    expect(USAGE).toContain('0..5')
  })

  it('an unknown flag is refused the same way', () => {
    const errOut: string[] = []
    const code = runCheck(['BL-1', '--nope'], { log: () => {}, err: (l: string) => errOut.push(l) })
    expect(code).not.toBe(0)
    expect(errOut.join('\n')).toContain('--nope')
  })

  it('the report always prints exactly five receipts plus the number, in a fixed order', () => {
    const report = formatReport(evaluate({}))
    expect(report.lines).toHaveLength(PARITY_RECEIPT_COUNT + 1)
    expect(report.lines.slice(0, PARITY_RECEIPT_COUNT).every((l) => /^(OK|FAIL|n-a) — /.test(l))).toBe(true)
    expect(report.lines[PARITY_RECEIPT_COUNT]).toBe('0') // an empty run earns nothing
    expect(report.exitCode).not.toBe(0)
  })
})
