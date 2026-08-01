/**
 * Tests for scripts/sma/lib/baseline.mjs — the measurement orchestrator (track A).
 *
 *   - Test 1 (captureRetrieval shape + math): the documented report shape over a fixture
 *     corpus + fixture gold cases; recall and critical_miss_rate are the documented fractions.
 *   - Test 2 (critical-miss path): a gold case whose critical note never loads lands in
 *     critical_misses AND raises critical_miss_rate.
 *   - Test 3 (determinism): two runs over the same inputs are deep-equal AND byte-equal.
 *   - Test 4 (receipt-recordability): every capture carries a check_command that passes the
 *     SAFE_COMMAND allowlist and can be recorded by receipts.recordReceipt unmodified.
 *   - Test 5 (context cost delegates): captureContextCost's numbers ARE economy.corpusStats'
 *     numbers, stamped with the same estimator version + caveat.
 *   - Test 6 (no parallel estimator): baseline.mjs imports economy.mjs and implements no
 *     token counting of its own (source assertion).
 *   - Test 7 (honest empties): zero cases / zero expected notes report null rates, never a
 *     fabricated 1.0; a missing cases file is an honest empty report, not a throw.
 *   - Test 8 (hook entry discovery): the timed command is DISCOVERED from the settings
 *     hooks block — no hook path is hardcoded in the module (source assertion).
 *   - Test 9 (latency math): N timed runs report p50 <= p95, a mean, the entry command and
 *     an allowlist-safe check_command; nothing is discarded (runs == samples).
 *   - Test 10 (real spawn): the DEFAULT runner actually spawns the entry and times it.
 *   - Test 11 (honest empty latency): no discoverable hook entry -> null stats, never a
 *     fabricated 0 ms.
 *   - Test 12 (recovery, env down): an unreachable queue is 'environment-unavailable' WITH
 *     NO recovery_ms — the drill never invents a number it did not measure.
 *   - Test 13 (recovery, measured): a reachable queue + a drill that returns a number
 *     reports 'measured' with that number.
 *   - Test 14 (recovery, drill fails): a throwing drill degrades to the honest branch and
 *     the connection string is MASKED out of the detail.
 *   - Test 15 (recovery kills nothing): the module signals no pid at all (source assertion).
 *   - Test 16 (clean install): wall_ms + per-step timings through an injected step runner.
 *   - Test 17 (clean install, failing step): reported incomplete, never as an install time.
 *   - Test 18 (capture-all): the five metrics under one entry; a metric whose input is
 *     absent is SKIPPED WITH A REASON, never reported as a zero.
 *   - Test 19 (record): every captured report becomes a receipt; the wall-clock metrics
 *     bind command+exit only, the pure ones bind stdout too.
 *   - Test 20 (replay): recorded receipts re-verify, and a changed deterministic output
 *     surfaces as divergent rather than passing quietly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  captureRetrieval,
  captureContextCost,
  captureHookLatency,
  captureWorkerRecovery,
  captureCleanInstall,
  captureAll,
  recordBaselineReceipts,
  replayBaselineReceipts,
  discoverHookEntry,
  BASELINE_METRICS,
  DETERMINISTIC_METRICS,
  receiptIdFor,
  HOOK_LATENCY_CHECK_COMMAND,
  WORKER_RECOVERY_CHECK_COMMAND,
  CLEAN_INSTALL_CHECK_COMMAND,
} from '../lib/baseline.mjs'
import { corpusStats, ESTIMATOR_VERSION, APPROX_CAVEAT } from '../lib/economy.mjs'
import { isSafeCommand } from '../lib/predict.mjs'
import { recordReceipt } from '../lib/receipts.mjs'

const EMDASH = String.fromCharCode(0x2014)

const TAGS =
  `## area\n- crm ${EMDASH} customer relationship\n- auth ${EMDASH} authentication\n\n## kind\n- bug-lesson ${EMDASH} a burn\n`

let dir: string
let corpusDir: string
let casesPath: string

function writeNote(file: string, description: string, tags: string[], importance: number) {
  const fm = ['---', `description: ${description}`, 'kind: reference', `tags: [${tags.join(', ')}]`, `importance: ${importance}`, '---', 'body']
  writeFileSync(join(corpusDir, file), fm.join('\n') + '\n', 'utf8')
}

function writeCases(lines: object[]) {
  writeFileSync(casesPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-baseline-'))
  corpusDir = join(dir, 'memory')
  casesPath = join(dir, 'cases.jsonl')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(join(corpusDir, 'TAGS.md'), TAGS, 'utf8')
  writeFileSync(join(corpusDir, 'MEMORY.md'), '# index\n- a core line\n- another core line\n', 'utf8')
  writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9)
  writeNote('crm-detail.md', 'a crm periphery note', ['crm'], 5)
  writeNote('auth-detail.md', 'an auth note a crm task never names', ['auth'], 3)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const opts = () => ({ corpusDir, casesPath, tagsPath: join(corpusDir, 'TAGS.md'), commit: 'c' })

describe('captureRetrieval — report shape and recall math (Tests 1-2)', () => {
  it('reports hits, misses, critical misses and the documented fractions', () => {
    writeCases([
      // 2 of 3 expected notes load; the critical one does not
      { task: 'fix the crm handler', expected_notes: ['core-rule.md', 'crm-detail.md', 'auth-detail.md'], critical_notes: ['auth-detail.md'], forbidden_notes: [] },
      // everything expected loads (CORE always does)
      { task: 'read the crm rule', expected_notes: ['core-rule.md'], critical_notes: ['core-rule.md'], forbidden_notes: [] },
    ])

    const r = captureRetrieval(opts())

    expect(r.metric).toBe('retrieval-recall')
    expect(r.cases).toBe(2)
    expect(r.expected).toBe(4)
    expect(r.hits).toBe(3)
    expect(r.core_loaded).toEqual(['core-rule.md'])

    expect(r.misses).toEqual([{ case: 'fix the crm handler', missing_notes: ['auth-detail.md'] }])
    expect(r.critical_misses).toEqual([{ case: 'fix the crm handler', missing_notes: ['auth-detail.md'] }])
    expect(r.forbidden_hits).toEqual([])

    // recall = hit expected notes / all expected notes; critical_miss_rate = cases with a
    // critical miss / cases
    expect(r.summary.recall).toBeCloseTo(0.75, 6)
    expect(r.summary.critical_miss_rate).toBeCloseTo(0.5, 6)
  })

  it('a forbidden note that loads anyway is reported', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['crm-detail.md'], critical_notes: [], forbidden_notes: ['core-rule.md'] }])
    const r = captureRetrieval(opts())
    expect(r.forbidden_hits).toEqual([{ case: 'fix the crm handler', forbidden_notes: ['core-rule.md'] }])
    expect(r.summary.critical_miss_rate).toBe(0)
  })

  /**
   * Test 21 — THE DEFAULT TAG REGISTRY. Every other test in this file hands the capture an
   * explicit tagsPath, so the documented default («defaults to <corpusDir>/TAGS.md») was
   * never exercised. Without a registry the loader derives no task tags AND selects no core,
   * so the pack comes back empty and the capture reports recall 0 — a fabricated number that
   * looks exactly like a genuinely blind retrieval layer. A measurement that silently
   * measures nothing is worse than no measurement, so the default is pinned by a test.
   */
  it('resolves the corpus TAGS.md by default — an omitted tagsPath measures the same thing', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['core-rule.md', 'crm-detail.md'], critical_notes: [], forbidden_notes: [] }])

    const withPath = captureRetrieval(opts())
    const { tagsPath: _omitted, ...withoutPath } = opts()
    const defaulted = captureRetrieval(withoutPath)

    expect(defaulted.hits).toBe(withPath.hits)
    expect(defaulted.core_loaded).toEqual(withPath.core_loaded)
    expect(defaulted.summary.recall).toBe(withPath.summary.recall)
    // and the shared number is a real one, not the empty-pack zero
    expect(defaulted.summary.recall).toBeGreaterThan(0)
    expect(defaulted.core_loaded).toEqual(['core-rule.md'])
  })
})

describe('determinism (Test 3)', () => {
  it('two runs over the same inputs produce identical report bytes', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['core-rule.md', 'auth-detail.md'], critical_notes: ['auth-detail.md'], forbidden_notes: [] }])

    const a = captureRetrieval(opts())
    const b = captureRetrieval(opts())
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/) // no clock in the bytes

    const c1 = captureContextCost({ corpusDir })
    const c2 = captureContextCost({ corpusDir })
    expect(JSON.stringify(c1)).toBe(JSON.stringify(c2))
    expect(JSON.stringify(c1)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })
})

describe('receipt-recordability (Test 4)', () => {
  it('both captures carry an allowlist-safe check_command recordReceipt accepts', () => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] }])
    const reports = [captureRetrieval(opts()), captureContextCost({ corpusDir })]

    for (const r of reports) {
      expect(typeof r.check_command).toBe('string')
      expect(r.check_command.startsWith('node scripts/sma/cli.mjs baseline')).toBe(true)
      expect(isSafeCommand(r.check_command)).toBe(true)

      const rec = recordReceipt({
        entry: { id: `BASE-${r.metric}`, assertion: `the ${r.metric} measurement re-runs`, check_command: r.check_command },
        runCommand: () => ({ stdout: 'ok\n', exitCode: 0 }),
      })
      expect(rec.error).toBeUndefined()
      expect(rec.receipt?.expected_sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('captureContextCost — delegation to the economy estimator (Tests 5-6)', () => {
  it('carries corpusStats numbers verbatim, with the estimator version and caveat', () => {
    const stats = corpusStats({ corpusDir })
    const r = captureContextCost({ corpusDir })

    expect(r.metric).toBe('context-cost')
    expect(r.totals).toEqual(stats.totals)
    expect(r.estimator_version).toBe(ESTIMATOR_VERSION)
    expect(r.caveat).toBe(APPROX_CAVEAT)

    // per_file lists MEMORY.md as the core load plus every note/index, tokens verbatim
    const core = r.per_file.find((f: { file: string }) => f.file === 'MEMORY.md')
    expect(core).toMatchObject({ kind: 'core', tokens: stats.core })
    const note = r.per_file.find((f: { file: string }) => f.file === 'crm-detail.md')
    expect(note?.kind).toBe('note')
    expect(note?.tokens).toBe(stats.notes.find((n: { file: string }) => n.file === 'crm-detail.md')?.tokens)
    expect(r.per_file.filter((f: { kind: string }) => f.kind === 'note')).toHaveLength(stats.notes.length)
  })

  it('implements no token counter of its own — the estimator is imported (source assertion)', () => {
    const src = readFileSync(fileURLToPath(new URL('../lib/baseline.mjs', import.meta.url)), 'utf8')
    expect(src).toMatch(/from '\.\/economy\.mjs'/)
    expect(src).toMatch(/corpusStats/)
    // no parallel byte/token math anywhere in this module
    expect(src).not.toMatch(/Buffer\.byteLength/)
    expect(src).not.toMatch(/function estimateTokens/)
  })
})

describe('honest empties (Test 7)', () => {
  it('reports null rates instead of a fabricated 1.0, and survives a missing cases file', () => {
    writeCases([])
    const empty = captureRetrieval(opts())
    expect(empty.cases).toBe(0)
    expect(empty.summary.recall).toBeNull()
    expect(empty.summary.critical_miss_rate).toBeNull()

    const absent = captureRetrieval({ ...opts(), casesPath: join(dir, 'no-such-file.jsonl') })
    expect(absent.cases).toBe(0)
    expect(absent.summary.recall).toBeNull()

    // a corpus with no MEMORY.md reports an honest null core, never 0-as-if-measured
    const bare = mkdtempSync(join(tmpdir(), 'sma-baseline-bare-'))
    try {
      const cost = captureContextCost({ corpusDir: bare })
      expect(cost.totals.core).toBeNull()
      expect(cost.per_file).toEqual([])
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('skips corrupt gold-case lines instead of failing the capture', () => {
    writeFileSync(
      casesPath,
      [JSON.stringify({ task: 'fix the crm handler', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] }), 'not json', ''].join('\n'),
      'utf8',
    )
    const r = captureRetrieval(opts())
    expect(r.cases).toBe(1)
    expect(r.corrupt_lines).toBe(1)
    expect(r.summary.recall).toBe(1)
  })
})

describe('captureHookLatency — timing the INSTALLED hook entry (Tests 8-11)', () => {
  const SETTINGS = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node scripts/sma/cli.mjs session-start', timeout: 10 }] }],
      PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'node scripts/sma/cli.mjs pre', timeout: 5 }] }],
      PostToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'node scripts/sma/cli.mjs stall-check', timeout: 5 }] }],
    },
  }

  function settingsFile(body: object = SETTINGS, name = 'settings.json') {
    const p = join(dir, name)
    writeFileSync(p, JSON.stringify(body, null, 2), 'utf8')
    return p
  }

  it('discovers the entry from the settings hooks block — nothing hardcoded (Test 8)', () => {
    const found = discoverHookEntry(settingsFile())
    // default = the per-tool-call hot path, the one an adopter pays for on EVERY edit
    expect(found?.command).toBe('node scripts/sma/cli.mjs pre')
    expect(found?.event).toBe('PreToolUse')
    expect(found?.matcher).toBe('Edit|Write|Bash')

    // any wired event can be asked for by name
    expect(discoverHookEntry(settingsFile(), { hook: 'SessionStart' })?.command).toBe('node scripts/sma/cli.mjs session-start')
    expect(discoverHookEntry(settingsFile(), { hook: 'stall-check' })?.command).toBe('node scripts/sma/cli.mjs stall-check')

    // an absent / unreadable / shapeless settings file is an honest null, never a throw
    expect(discoverHookEntry(join(dir, 'no-such.json'))).toBeNull()
    expect(discoverHookEntry(settingsFile({ hooks: {} }, 'empty.json'))).toBeNull()

    // the module names no hook command of its own — discovery only
    const src = readFileSync(fileURLToPath(new URL('../lib/baseline.mjs', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/cli\.mjs (pre|session-start|stall-check)/)
  })

  it('times N runs and reports p50 <= p95, mean and an allowlist-safe check_command (Test 9)', () => {
    const elapsed = [5, 1, 3, 9, 2] // ms per run, in call order
    let clock = 0
    let calls = 0
    const seen: string[] = []

    const r = captureHookLatency({
      runs: 5,
      settingsPath: settingsFile(),
      hrtime: () => clock,
      run: (cmd: string) => {
        seen.push(cmd)
        clock += elapsed[calls++]
        return { exitCode: 0 }
      },
    })

    expect(r.metric).toBe('hook-latency')
    expect(r.entry_command).toBe('node scripts/sma/cli.mjs pre')
    expect(r.hook_event).toBe('PreToolUse')
    expect(seen).toEqual(Array(5).fill('node scripts/sma/cli.mjs pre'))

    // nothing is discarded: every requested run is a sample
    expect(r.runs).toBe(5)
    // nearest-rank over [1,2,3,5,9]
    expect(r.p50_ms).toBe(3)
    expect(r.p95_ms).toBe(9)
    expect(r.mean_ms).toBe(4)
    expect(r.p50_ms).toBeLessThanOrEqual(r.p95_ms)
    expect(r.nonzero_exits).toBe(0)

    expect(r.check_command).toBe(HOOK_LATENCY_CHECK_COMMAND)
    expect(isSafeCommand(r.check_command)).toBe(true)
    const rec = recordReceipt({
      entry: { id: 'BASE-hook-latency', assertion: 'the hook-latency measurement re-runs', check_command: r.check_command },
      runCommand: () => ({ stdout: 'ok\n', exitCode: 0 }),
    })
    expect(rec.error).toBeUndefined()
  })

  it('a nonzero exit is COUNTED, never silently timed away (Test 9b)', () => {
    let clock = 0
    const r = captureHookLatency({
      runs: 3,
      settingsPath: settingsFile(),
      hrtime: () => (clock += 1),
      run: () => ({ exitCode: 1 }),
    })
    expect(r.runs).toBe(3)
    expect(r.nonzero_exits).toBe(3)
  })

  it('the DEFAULT runner really spawns the entry and times it (Test 10)', () => {
    const p = settingsFile({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node -e 0' }] }] } }, 'real.json')
    const r = captureHookLatency({ runs: 3, settingsPath: p })
    expect(r.runs).toBe(3)
    expect(r.entry_command).toBe('node -e 0')
    expect(Number.isFinite(r.mean_ms)).toBe(true)
    expect(r.mean_ms).toBeGreaterThan(0)
    expect(r.p50_ms).toBeLessThanOrEqual(r.p95_ms)
    expect(r.nonzero_exits).toBe(0)
  })

  it('honest empty: no discoverable entry -> null stats, never a fabricated 0 ms (Test 11)', () => {
    const r = captureHookLatency({ settingsPath: settingsFile({ hooks: {} }, 'none.json') })
    expect(r.runs).toBe(0)
    expect(r.p50_ms).toBeNull()
    expect(r.p95_ms).toBeNull()
    expect(r.mean_ms).toBeNull()
    expect(r.entry_command).toBeNull()
    expect(r.detail).toMatch(/hook/i)
    expect(r.check_command).toBe(HOOK_LATENCY_CHECK_COMMAND)

    // a missing settings file is the same honest empty, not a throw
    expect(captureHookLatency({ settingsPath: join(dir, 'no-such.json') }).runs).toBe(0)
  })
})

describe('captureWorkerRecovery — the honest two-branch outcome (Tests 12-15)', () => {
  // Credentials on purpose: the report must never carry them back out.
  const DOWN_URL = 'postgres://drill:s3cret@127.0.0.1:1/sma_queue'

  it('an unreachable queue reports environment-unavailable and NO recovery_ms (Test 12)', async () => {
    // the REAL probe against a port nothing listens on — no injection, the honest path
    const r = await captureWorkerRecovery({ queueUrl: DOWN_URL, probeTimeoutMs: 500 })

    expect(r.metric).toBe('worker-recovery')
    expect(r.status).toBe('environment-unavailable')
    expect('recovery_ms' in r).toBe(false) // absent, not null-with-a-number-shape
    expect(typeof r.detail).toBe('string')
    expect(r.detail.length).toBeGreaterThan(0)

    // T-…-04: no credentials, no connection string in a report that gets recorded
    expect(r.detail).not.toContain('s3cret')
    expect(r.detail).not.toContain('postgres://')
    expect(JSON.stringify(r)).not.toContain('s3cret')

    expect(r.check_command).toBe(WORKER_RECOVERY_CHECK_COMMAND)
    expect(isSafeCommand(r.check_command)).toBe(true)

    // an absent queue url is the SAME honest branch, not a throw
    const none = await captureWorkerRecovery({})
    expect(none.status).toBe('environment-unavailable')
    expect('recovery_ms' in none).toBe(false)
  })

  it('a reachable queue + a drill that measures reports the number (Test 13)', async () => {
    const seen: unknown[] = []
    const r = await captureWorkerRecovery({
      queueUrl: DOWN_URL,
      probe: async (t: object) => {
        seen.push(t)
        return true
      },
      drill: async () => ({ recovery_ms: 12345, detail: 'claim abandoned; redelivered after expiry' }),
    })
    expect(r.status).toBe('measured')
    expect(r.recovery_ms).toBe(12345)
    expect(r.detail).toMatch(/redelivered/)
    expect(seen).toHaveLength(1)

    // the receipt path accepts it unmodified
    const rec = recordReceipt({
      entry: { id: 'BASE-worker-recovery', assertion: 'the worker-recovery drill re-runs', check_command: r.check_command },
      runCommand: () => ({ stdout: 'ok\n', exitCode: 0 }),
    })
    expect(rec.error).toBeUndefined()
  })

  it('a failing or numberless drill NEVER becomes a measurement (Test 14)', async () => {
    const thrown = await captureWorkerRecovery({
      queueUrl: DOWN_URL,
      probe: async () => true,
      drill: async () => {
        throw new Error(`connect ECONNREFUSED for ${DOWN_URL}`)
      },
    })
    expect(thrown.status).toBe('environment-unavailable')
    expect('recovery_ms' in thrown).toBe(false)
    expect(thrown.detail).toContain('ECONNREFUSED')
    expect(thrown.detail).not.toContain('s3cret') // masked
    expect(thrown.detail).not.toContain('127.0.0.1:1')

    const numberless = await captureWorkerRecovery({
      queueUrl: DOWN_URL,
      probe: async () => true,
      drill: async () => ({ detail: 'the claim never came back within the window' }),
    })
    expect(numberless.status).toBe('environment-unavailable')
    expect('recovery_ms' in numberless).toBe(false)
    expect(numberless.detail).toMatch(/never came back/)
  })

  it('the drill signals no process — it kills nothing at all (Test 15)', () => {
    const src = readFileSync(fileURLToPath(new URL('../lib/baseline.mjs', import.meta.url)), 'utf8')
    // T-…-03: the safest way to never kill a foreign pid is to never signal one.
    expect(src).not.toMatch(/process\.kill/)
    expect(src).not.toMatch(/\.kill\(/)
    expect(src).not.toMatch(/SIGKILL|SIGTERM/)
    expect(src).not.toMatch(/taskkill/)
  })
})

describe('captureCleanInstall — the timed fresh install (Tests 16-17)', () => {
  it('reports wall_ms and per-step timings through an injected runner (Test 16)', () => {
    let clock = 0
    const calls: string[] = []
    const r = captureCleanInstall({
      repoRoot: dir,
      tmpDir: join(dir, 'install-scratch'),
      hrtime: () => clock,
      exec: (file: string) => {
        calls.push(file)
        clock += 100
        return ''
      },
    })

    expect(r.metric).toBe('clean-install')
    expect(r.status).toBe('measured')
    expect(r.steps.map((s: { name: string }) => s.name)).toEqual(['clone', 'install'])
    expect(r.steps.every((s: { ok: boolean }) => s.ok)).toBe(true)
    expect(r.steps.map((s: { ms: number }) => s.ms)).toEqual([100, 100])
    expect(r.wall_ms).toBe(200)
    expect(calls).toHaveLength(2) // one clone, one install — nothing else spawned

    expect(r.check_command).toBe(CLEAN_INSTALL_CHECK_COMMAND)
    expect(isSafeCommand(r.check_command)).toBe(true)
    // T-…-04: no machine paths in a report that gets recorded
    expect(JSON.stringify(r)).not.toContain('install-scratch')
  })

  it('a failing step is reported incomplete, never as an install timing (Test 17)', () => {
    let clock = 0
    const r = captureCleanInstall({
      repoRoot: dir,
      tmpDir: join(dir, 'install-scratch-2'),
      hrtime: () => (clock += 50),
      exec: (file: string, args: string[]) => {
        if (String(args?.[0] ?? '').includes('init')) throw new Error('install exploded')
        return ''
      },
    })
    expect(r.status).toBe('incomplete')
    expect(r.steps[1].ok).toBe(false)
    expect(r.steps[1].detail).toMatch(/exploded/)
    expect(Number.isFinite(r.wall_ms)).toBe(true)
  })
})

describe('the whole baseline: capture -> record -> replay (Tests 18-20)', () => {
  // The two wall-clock captures are doubled here ON PURPOSE: this suite is about the
  // orchestration, and spawning an installer to prove a list has five entries would be
  // paying minutes for nothing. Their own behavior is Tests 8-17.
  const doubles = {
    hookLatency: () => ({ metric: 'hook-latency', runs: 20, p50_ms: 41, p95_ms: 88, mean_ms: 47, entry_command: 'node -e 0', hook_event: 'PreToolUse', nonzero_exits: 0, check_command: HOOK_LATENCY_CHECK_COMMAND }),
    workerRecovery: async () => ({ metric: 'worker-recovery', status: 'environment-unavailable', detail: 'no queue here', check_command: WORKER_RECOVERY_CHECK_COMMAND }),
    cleanInstall: () => ({ metric: 'clean-install', status: 'measured', wall_ms: 9000, steps: [], check_command: CLEAN_INSTALL_CHECK_COMMAND }),
  }

  const allOpts = () => ({ corpusDir, casesPath, settingsPath: join(dir, 'settings.json'), repoRoot: dir, capture: doubles })

  beforeEach(() => {
    writeCases([{ task: 'fix the crm handler', expected_notes: ['core-rule.md'], critical_notes: [], forbidden_notes: [] }])
  })

  it('captures the five metrics, and SKIPS a metric whose input is absent (Test 18)', async () => {
    const all = await captureAll(allOpts())
    expect(all.reports.map((r: { metric: string }) => r.metric)).toEqual(BASELINE_METRICS)
    expect(all.skipped).toEqual([])
    expect(all.reports.every((r: { report: { check_command: string } }) => isSafeCommand(r.report.check_command))).toBe(true)

    // no gold cases -> retrieval is skipped WITH A REASON, never scored as 0 recall
    const noCases = await captureAll({ ...allOpts(), casesPath: join(dir, 'no-such.jsonl') })
    expect(noCases.reports.map((r: { metric: string }) => r.metric)).not.toContain('retrieval')
    expect(noCases.skipped).toEqual([{ metric: 'retrieval', reason: expect.stringContaining('gold-cases') }])

    // --only narrows to the exact form a recorded check_command re-runs
    const one = await captureAll({ ...allOpts(), only: 'context-cost' })
    expect(one.reports).toHaveLength(1)
    expect(one.reports[0].report.metric).toBe('context-cost')

    // an unknown metric is a named skip, not a silent empty run
    const bogus = await captureAll({ ...allOpts(), only: 'latency' })
    expect(bogus.reports).toEqual([])
    expect(bogus.skipped[0]).toMatchObject({ metric: 'latency' })
  })

  it('records one receipt per metric; only the pure metrics bind stdout (Test 19)', async () => {
    const { reports } = await captureAll(allOpts())
    const { receipts, errors } = recordBaselineReceipts({
      reports,
      runCommand: (cmd: string) => ({ stdout: `report for ${cmd}\n`, exitCode: 0 }),
    })

    expect(errors).toEqual([])
    expect(receipts.map((r: { id: string }) => r.id)).toEqual(BASELINE_METRICS.map(receiptIdFor))
    for (const r of receipts) {
      expect(r.expected_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(r.expected_exit).toBe(0)
      expect(r.assertion.length).toBeGreaterThan(0)
    }

    // a wall-clock measurement re-runs to DIFFERENT milliseconds by nature: binding its
    // stdout would manufacture a divergence at every honest replay
    const boundStdout = receipts.filter((r: { hash_stdout: boolean }) => r.hash_stdout).map((r: { id: string }) => r.id)
    expect(boundStdout).toEqual(DETERMINISTIC_METRICS.map(receiptIdFor))

    // a command off the allowlist is refused, never recorded
    const refused = recordBaselineReceipts({
      reports: [{ metric: 'retrieval', report: { check_command: 'rm -rf /' } }],
      runCommand: () => ({ stdout: '', exitCode: 0 }),
    })
    expect(refused.receipts).toEqual([])
    expect(refused.errors[0].metric).toBe('retrieval')
  })

  it('replays recorded receipts and reports what no longer reproduces (Test 20)', async () => {
    const { reports } = await captureAll(allOpts())
    const stable = (cmd: string) => ({ stdout: `report for ${cmd}\n`, exitCode: 0 })
    const { receipts } = recordBaselineReceipts({ reports, runCommand: stable })

    const clean = replayBaselineReceipts({ receipts, runCommand: stable, now: 'T' })
    expect(clean.invalid).toEqual([])
    expect(clean.divergent).toEqual([])
    expect(clean.records.every((r: { verdict: string }) => r.verdict === 'verified')).toBe(true)

    // the corpus changed: the DETERMINISTIC metrics diverge, the wall-clock ones (command
    // + exit bound only) still verify — exactly the signal a re-measurement wants
    const drifted = replayBaselineReceipts({
      receipts,
      runCommand: (cmd: string) => ({ stdout: `DIFFERENT report for ${cmd}\n`, exitCode: 0 }),
      now: 'T',
    })
    expect(drifted.divergent.map((r: { id: string }) => r.id)).toEqual(DETERMINISTIC_METRICS.map(receiptIdFor))

    // a check that stops running at all is divergent too (exit code is always bound)
    const broken = replayBaselineReceipts({ receipts, runCommand: () => ({ stdout: '', exitCode: 1 }), now: 'T' })
    expect(broken.divergent).toHaveLength(receipts.length)
  })
})
