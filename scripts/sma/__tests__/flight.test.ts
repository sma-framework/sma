/**
 * Tests for the deterministic pre-compaction FLIGHT RECORDER (Phase 9.2 Plan 06,
 * D-9.2-09). Lib core (Task 1, tests 1-8) + CLI wiring (Task 2, tests 9-13).
 *
 * The capsule makes auto-compaction survivable with PURE file assembly — zero LLM,
 * zero network, zero child_process in the path. Every lib fs dependency is injected
 * (opts.flightDir) so tests never touch the real repo; the CLI tests spawn the real
 * cli.mjs against a per-test temp root via SMA_ROOT_OVERRIDE.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  appendMark,
  readMarks,
  buildCapsule,
  writeCapsule,
  writeHandoff,
  scanForSecrets,
  SECRET_PATTERNS,
  nativeProbe,
  buildResumeBrief,
  buildHandoffBrief,
  CAPSULE_BUDGET,
} from '../lib/flight.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-flight-'))
})
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/** A fully-injected capsule fixture — every source present, clock injected. */
function capsuleFixture(overrides: Record<string, unknown> = {}) {
  return {
    now: '2026-07-08T12:00:00.000Z',
    identity: { holderIdentity: 'Мозг', terminalId: 'mozg-abc123' },
    label: 'phase:9.2 — flight recorder',
    trigger: 'auto',
    statePosition: 'Phase: 9.2 — building the flight capsule',
    stateBlockers: ['Phase 9.2 blocked: re-measure p95 (ops)'],
    ownClaim: { globs: ['scripts/sma/lib/flight.mjs'], description: 'flight recorder', name: 'flight-slot' },
    otherClaims: [{ by: 'Фабрика', globs: ['src/**'] }],
    pushClaim: null,
    journalTail: [
      { type: 'claim', scope: 'flight', detail: { reason: 'claimed flight scope' } },
      { type: 'stall', scope: 'analysis-paralysis' },
    ],
    marksTail: [
      { tool: 'Read', target: 'lib/journal.mjs' },
      { tool: 'Edit', target: 'lib/flight.mjs' },
    ],
    execState: { planId: '9.2-06', nextUndone: 2, complete: false },
    ...overrides,
  }
}

// ── Task 1: lib core (tests 1-8) ─────────────────────────────────────────────────

describe('flight marks (the generalized exec-journal)', () => {
  it('Test 1: appendMark round-trips through readMarks; a corrupt line is skip-and-counted', () => {
    const flightDir = join(tmp, 'flight')
    const m1 = appendMark({ tool: 'Edit', target: 'lib/flight.mjs' }, { terminalId: 'mozg-abc', flightDir, now: '2026-07-08T12:00:00.000Z' })
    expect(m1).toMatchObject({ ts: '2026-07-08T12:00:00.000Z', terminal: 'mozg-abc', seq: 1, tool: 'Edit', target: 'lib/flight.mjs' })
    const m2 = appendMark({ tool: 'Write', target: 'lib/x.mjs' }, { terminalId: 'mozg-abc', flightDir })
    expect(m2.seq).toBe(2)

    const round = readMarks({ flightDir })
    expect(round.marks.map((m: any) => m.seq)).toEqual([1, 2])
    expect(round.corrupt).toBe(0)

    // a corrupt line is skipped-and-counted, never a throw (journal.mjs posture)
    appendFileSync(join(flightDir, 'marks', 'mozg-abc.jsonl'), 'not json\n')
    const round2 = readMarks({ flightDir })
    expect(round2.marks.length).toBe(2)
    expect(round2.corrupt).toBe(1)
  })
})

describe('buildCapsule', () => {
  it('Test 2: 5 sections in fixed order; identical inputs -> byte-identical output (determinism)', () => {
    const inputs = capsuleFixture()
    const a = buildCapsule(inputs)
    const b = buildCapsule(capsuleFixture())
    expect(a).toBe(b) // byte-deterministic (P9.2-06-02)

    const iHeader = a.indexOf('# SMA Flight Capsule')
    const iTask = a.indexOf('## Current task')
    const iConstraints = a.indexOf('## Constraints')
    const iEvents = a.indexOf('## Recent decisions & events')
    const iResume = a.indexOf('## Resume')
    expect(iHeader).toBeGreaterThanOrEqual(0)
    expect(iHeader).toBeLessThan(iTask)
    expect(iTask).toBeLessThan(iConstraints)
    expect(iConstraints).toBeLessThan(iEvents)
    expect(iEvents).toBeLessThan(iResume)
    // the resume point rides the exec state
    expect(a).toContain('задача 2')
    expect(a).toContain('trigger: auto')
  })

  it('Test 3: 500 marks -> capsule <= CAPSULE_BUDGET; oldest dropped first + truncated marker; header + Current-task intact', () => {
    const marksTail = Array.from({ length: 500 }, (_, i) => ({ tool: 'Edit', target: `lib/file-${i}.mjs` }))
    const cap = buildCapsule(capsuleFixture({ marksTail }))
    expect(Buffer.byteLength(cap, 'utf8')).toBeLessThanOrEqual(CAPSULE_BUDGET)
    expect(cap).toContain('…truncated')
    // oldest dropped first: file-0 gone, a late file survives
    expect(cap).not.toContain('lib/file-0.mjs')
    expect(cap).toContain('lib/file-499.mjs')
    // header + Current-task are NEVER truncated
    expect(cap).toContain('# SMA Flight Capsule')
    expect(cap).toContain('## Current task')
    expect(cap).toContain('## Resume')
  })
})

describe('scanForSecrets', () => {
  it('Test 4: redacts AWS key / PRIVATE KEY header / Bearer / sk- token; clean text byte-identical; pure', () => {
    const aws = scanForSecrets('key AKIAIOSFODNN7EXAMPLE end')
    expect(aws.text).toBe('key [redacted:aws-access-key] end')

    const pk = scanForSecrets('-----BEGIN RSA PRIVATE KEY-----')
    expect(pk.text).toBe('[redacted:private-key-header]')

    const bearer = scanForSecrets('Authorization: Bearer abcDEF1234567890token')
    expect(bearer.text).toContain('[redacted:bearer-token]')
    expect(bearer.text).not.toContain('abcDEF1234567890token')

    const sk = scanForSecrets('openai sk-abc123DEF456ghi789 done')
    expect(sk.text).toContain('[redacted:sk-token]')
    expect(sk.text).not.toContain('sk-abc123DEF456ghi789')

    // clean text passes through byte-identical
    const clean = 'просто обычный текст без секретов — lib/flight.mjs задача 2'
    expect(scanForSecrets(clean).text).toBe(clean)

    // SECRET_PATTERNS is exported data (no fs); scan is pure
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true)
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(4)
  })
})

describe('writeCapsule', () => {
  it('Test 5: routes every line through scanForSecrets, writes intent.md + capsules/<id>.md; a seeded secret is in NEITHER file', () => {
    const flightDir = join(tmp, 'flight')
    const capsule = buildCapsule(capsuleFixture({
      journalTail: [{ type: 'note', scope: 'AKIAIOSFODNN7EXAMPLE leaked' }],
    }))
    // sanity: the raw capsule DID carry the secret before the write scrub
    expect(capsule).toContain('AKIAIOSFODNN7EXAMPLE')

    const res = writeCapsule({ capsule, terminalId: 'mozg-abc' }, { flightDir })
    expect(res.written).toEqual([join(flightDir, 'intent.md'), join(flightDir, 'capsules', 'mozg-abc.md')])
    expect(res.redactions.length).toBeGreaterThanOrEqual(1)

    const intent = readFileSync(join(flightDir, 'intent.md'), 'utf8')
    const perTerm = readFileSync(join(flightDir, 'capsules', 'mozg-abc.md'), 'utf8')
    expect(intent).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(perTerm).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(intent).toContain('[redacted:aws-access-key]')
  })
})

describe('nativeProbe + stand-down', () => {
  it('Test 6: native false by default; SMA_FLIGHT_NATIVE=1 -> native; native -> writeCapsule skips + writes nothing', () => {
    const def = nativeProbe({ env: {} })
    expect(def.native).toBe(false)
    expect(typeof def.reason).toBe('string')
    expect(nativeProbe({ env: { SMA_FLIGHT_NATIVE: '1' } }).native).toBe(true)

    const flightDir = join(tmp, 'flight')
    const res = writeCapsule({ capsule: 'x', terminalId: 't' }, { flightDir, env: { SMA_FLIGHT_NATIVE: '1' } })
    expect(res).toEqual({ skipped: 'native' })
    expect(existsSync(join(flightDir, 'intent.md'))).toBe(false)
  })
})

describe('continuation briefs', () => {
  it('Test 7: buildResumeBrief carries the resume point + claim + blockers + freshness; empty dir -> honest empty', () => {
    const brief = buildResumeBrief({ ...capsuleFixture(), capsuleFresh: '2026-07-08T12:00:00.000Z' })
    expect(brief).toContain('следующая задача 2')
    expect(brief).toContain('scripts/sma/lib/flight.mjs') // own claim scope
    expect(brief).toContain('re-measure p95') // STATE blocker
    expect(brief).toContain('2026-07-08T12:00:00.000Z') // freshness ts

    const empty = buildResumeBrief({})
    expect(empty).toContain('Флайт-журнал пуст')
    expect(() => buildResumeBrief({})).not.toThrow()
  })

  it('Test 8: buildHandoffBrief = resume + claim-transfer (exact release/claim commands + D-9-09 warning); write scrubs secrets', () => {
    const brief = buildHandoffBrief({ ...capsuleFixture(), capsuleFresh: '2026-07-08T12:00:00.000Z' })
    // everything resume has
    expect(brief).toContain('следующая задача 2')
    // PLUS a claim-transfer section with the exact commands
    expect(brief).toContain('## Передача claim')
    expect(brief).toContain('pnpm sma release flight-slot')
    expect(brief).toContain('pnpm sma claim')
    expect(brief).toContain('force-clear')
    expect(brief).toContain('D-9-09')

    // the handoff write path routes through scanForSecrets before disk
    const flightDir = join(tmp, 'flight')
    const leaky = brief + '\ntoken=AKIAIOSFODNN7EXAMPLE\n'
    const res = writeHandoff({ brief: leaky, terminalId: 'mozg-abc' }, { flightDir })
    const written = readFileSync(res.written[0], 'utf8')
    expect(written).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(res.redactions.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Task 2: CLI wiring (tests 9-13) ──────────────────────────────────────────────

/** Seed a temp SMA root with a session lease, a claim, an exec journal, marks, and STATE.md. */
function seedRoot(root: string, opts: { trigger?: string } = {}) {
  const smaDir = join(root, '.sma')
  // session lease
  const sessionsDir = join(smaDir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  // exec journal for an active plan
  const execDir = join(smaDir, 'exec')
  mkdirSync(execDir, { recursive: true })
  appendFileSync(
    join(execDir, '9.2-06.jsonl'),
    JSON.stringify({ ts: '2026-07-08T11:00:00.000Z', task: 1, event: 'task_complete', status: 'done' }) + '\n',
  )
  // claim
  const claimDir = join(smaDir, 'claims', 'flight-slot')
  mkdirSync(claimDir, { recursive: true })
  writeFileSync(
    join(claimDir, 'provenance.json'),
    JSON.stringify({ by: 'Мозг', scope: { globs: ['scripts/sma/lib/flight.mjs'], description: 'flight' }, at: '2026-07-08T11:00:00.000Z', reason: 'initial' }),
  )
  // marks
  const marksDir = join(smaDir, 'flight', 'marks')
  mkdirSync(marksDir, { recursive: true })
  appendFileSync(
    join(marksDir, 'seed.jsonl'),
    JSON.stringify({ ts: '2026-07-08T11:30:00.000Z', terminal: 'seed', seq: 1, tool: 'Edit', target: 'lib/flight.mjs' }) + '\n',
  )
  // STATE.md sibling of .sma (dirname(smaRoot)/.planning/STATE.md)
  const planningDir = join(root, '.planning')
  mkdirSync(planningDir, { recursive: true })
  writeFileSync(
    join(planningDir, 'STATE.md'),
    [
      '# STATE',
      '<!-- SMA-MANAGED:START -->',
      '## Current Position',
      '',
      '**Phase: 9.2 — building the flight capsule seed task**',
      '',
      '## Open Blockers',
      '',
      '- **Phase 9.2 blocked:** re-measure p95 before arming (ops)',
      '',
      '## Active Sessions',
      '',
      '<!-- SMA-MANAGED:END -->',
    ].join('\n'),
  )
  return smaDir
}

function runCli(args: string[], opts: { stdin?: string; root: string; env?: Record<string, string> }): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      input: opts.stdin ?? '',
      encoding: 'utf8',
      env: {
        ...process.env,
        SMA_ROOT_OVERRIDE: join(opts.root, '.sma'),
        SMA_TERMINAL_NAME: 'Мозг',
        ...(opts.env ?? {}),
      },
    })
    return { stdout, status: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout ?? '').toString(), status: typeof err.status === 'number' ? err.status : 1 }
  }
}

describe('CLI precompact-capsule', () => {
  it('Test 9: writes intent.md + capsules/<id>.md with the seeded task label; exits 0', () => {
    seedRoot(tmp)
    const r = runCli(['precompact-capsule'], { root: tmp, stdin: JSON.stringify({ session_id: 'sess-1', trigger: 'auto' }) })
    expect(r.status).toBe(0)
    const intent = readFileSync(join(tmp, '.sma', 'flight', 'intent.md'), 'utf8')
    expect(intent).toContain('# SMA Flight Capsule')
    expect(intent).toContain('building the flight capsule seed task')
  })

  it('Test 10: corrupted root -> exit 0, never throws (fail-open, hook never blocks compaction)', () => {
    const smaDir = join(tmp, '.sma')
    mkdirSync(join(smaDir, 'exec'), { recursive: true })
    writeFileSync(join(smaDir, 'exec', '9.2-06.jsonl'), '{{{ not json')
    mkdirSync(join(smaDir, 'claims'), { recursive: true })
    writeFileSync(join(smaDir, 'claims', 'garbage'), 'not even a dir marker')
    const r = runCli(['precompact-capsule'], { root: tmp, stdin: '{{{ not json' })
    expect(r.status).toBe(0)
  })

  it('Test 12: SMA_FLIGHT_DISABLE=1 writes nothing (exit 0); SMA_FLIGHT_NATIVE=1 stands down; flight probe prints 1', () => {
    seedRoot(tmp)
    const disabled = runCli(['precompact-capsule'], { root: tmp, stdin: JSON.stringify({ session_id: 's', trigger: 'auto' }), env: { SMA_FLIGHT_DISABLE: '1' } })
    expect(disabled.status).toBe(0)
    expect(existsSync(join(tmp, '.sma', 'flight', 'intent.md'))).toBe(false)

    const native = runCli(['precompact-capsule'], { root: tmp, stdin: JSON.stringify({ session_id: 's', trigger: 'auto' }), env: { SMA_FLIGHT_NATIVE: '1' } })
    expect(native.status).toBe(0)
    expect(existsSync(join(tmp, '.sma', 'flight', 'intent.md'))).toBe(false)

    const probeOn = runCli(['flight', 'probe'], { root: tmp, env: { SMA_FLIGHT_NATIVE: '1' } })
    expect(probeOn.stdout.trim().split('\n').pop()).toBe('1')
    const probeOff = runCli(['flight', 'probe'], { root: tmp })
    expect(probeOff.stdout.trim().split('\n').pop()).toBe('0')
  })
})

describe('CLI session-start restore reflex', () => {
  it('Test 11: source=compact injects the capsule body FIRST; source=startup does NOT inject it', () => {
    seedRoot(tmp)
    // pre-seed a capsule for THIS window's terminalId. Resolve it by writing intent.md
    // fallback (session-start reads capsules/<terminalId>.md, falling back to intent.md).
    const flightDir = join(tmp, '.sma', 'flight')
    mkdirSync(flightDir, { recursive: true })
    writeFileSync(join(flightDir, 'intent.md'), '# SMA Flight Capsule\n\nMARKER-CAPSULE-BODY\n')

    const compact = runCli(['session-start'], { root: tmp, stdin: JSON.stringify({ session_id: 'sess-x', source: 'compact' }) })
    expect(compact.status).toBe(0)
    const parsed = JSON.parse(compact.stdout.trim().split('\n').find((l) => l.trim().startsWith('{')) as string)
    const ctx = parsed.hookSpecificOutput.additionalContext as string
    expect(ctx).toContain('MARKER-CAPSULE-BODY')
    // the capsule body is the FIRST part
    expect(ctx.indexOf('MARKER-CAPSULE-BODY')).toBeLessThan(ctx.indexOf('SMA:'))

    const startup = runCli(['session-start'], { root: tmp, stdin: JSON.stringify({ session_id: 'sess-x', source: 'startup' }) })
    expect(startup.stdout).not.toContain('MARKER-CAPSULE-BODY')
  })
})

describe('CLI resume / handoff / flight determinism-check', () => {
  it('Test 13: resume --json parses; handoff writes handoff-<id>.md; flight determinism-check prints 1', () => {
    seedRoot(tmp)
    const resume = runCli(['resume', '--json'], { root: tmp })
    const obj = JSON.parse(resume.stdout.trim().split('\n').find((l) => l.trim().startsWith('{')) as string)
    expect(obj).toHaveProperty('currentTask')
    expect(obj).toHaveProperty('nextStep')
    expect(obj).toHaveProperty('capsuleFresh')

    const handoff = runCli(['handoff'], { root: tmp })
    expect(handoff.status).toBe(0)
    const flightDir = join(tmp, '.sma', 'flight')
    // the printed path points at a handoff-*.md that exists
    const printed = handoff.stdout.trim().split('\n').pop() as string
    expect(printed).toContain('handoff-')
    expect(existsSync(printed)).toBe(true)
    expect(readFileSync(printed, 'utf8')).toContain('## Передача claim')

    const det = runCli(['flight', 'determinism-check'], { root: tmp })
    expect(det.stdout.trim().split('\n').pop()).toBe('1')
    void flightDir
  })
})
