/**
 * Tests for scripts/sma/lib/registry.mjs (Phase 49 Plan 05, Task 1).
 *
 * R7 heartbeat session registry (B15 lease schema, D-49-01 identity, D-49-11 grading):
 *   - Test 1: heartbeat() on a clean dir creates <terminalId>.json with the FULL
 *     B15 schema.
 *   - Test 2: heartbeat() again within HEARTBEAT_INTERVAL_MS, unchanged scope/status
 *     SKIPS the write (mtime-check-then-skip throttle; RESEARCH OQ2).
 *   - Test 3: heartbeat() with a NEW scope updates the file, increments transitions
 *     (B28), preserves acquireTime.
 *   - Test 4: corrupted sessions dir / malformed JSON -> heartbeat() + readSessions()
 *     return safe results, never throw (P4 fail-open fixture).
 *   - Test 5: readSessions() over two files with the SAME holderIdentity but different
 *     pids -> flags a duplicate-identity WARN naming both pids (SPEC edge: concurrency R7).
 *   - Test 6: classifyStaleness — fresh / attention / reap-eligible; a reap-eligible
 *     entry whose claimed-scope files have fresh mtimes -> 'needs-human' (dirty), and
 *     nothing in the module deletes it (P3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveTerminalIdentity,
  heartbeat,
  readSessions,
  classifyStaleness,
  reapStale,
  probeScopeMtime,
  resolveWorkLabel,
  displayIdentity,
  buildJournalActors,
} from '../lib/registry.mjs'
import { appendEvent, journalTail } from '../lib/journal.mjs'
import {
  HEARTBEAT_INTERVAL_MS,
  ATTENTION_AFTER_MISSES,
  SESSION_TTL_MS,
  GRACE_MS,
} from '../lib/constants.mjs'

const B15_KEYS = [
  'holderIdentity',
  'pid',
  'scope',
  'status',
  'blockers',
  'acquireTime',
  'renewTime',
  'leaseDurationSeconds',
  'transitions',
]

let sessionsDir: string

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'sma-registry-'))
})

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true })
})

describe('resolveTerminalIdentity (D-49-01)', () => {
  it('uses SMA_TERMINAL_NAME when set; slugifies for terminalId; pid rides along', () => {
    const id = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'Фабрика' } })
    expect(id.holderIdentity).toBe('Фабрика')
    expect(id.terminalId).toMatch(/^[a-z0-9-]+$/)
    expect(id.pid).toBe(process.pid)
  })

  it('falls back to T-<pid> when the env var is absent', () => {
    const id = resolveTerminalIdentity({ env: {} })
    expect(id.holderIdentity).toBe(`T-${process.pid}`)
    expect(id.terminalId).toBe(`t-${process.pid}`)
  })

  it('WR-05: two windows sharing a latin name get DISTINCT terminalIds (pid suffix)', () => {
    const a = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 100 })
    const b = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 200 })
    expect(a.holderIdentity).toBe('exec')
    expect(b.holderIdentity).toBe('exec')
    expect(a.terminalId).toBe('exec-100')
    expect(b.terminalId).toBe('exec-200')
    expect(a.terminalId).not.toBe(b.terminalId) // no lease/journal-file collision
  })

  it('WR-05: two windows sharing a non-latin name get DISTINCT terminalIds too', () => {
    const a = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'Мозг' }, pid: 100 })
    const b = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'Мозг' }, pid: 200 })
    expect(a.terminalId).toBe('t-100')
    expect(b.terminalId).toBe('t-200')
    expect(a.terminalId).not.toBe(b.terminalId)
  })
})

describe('resolveTerminalIdentity — window-stable across sequential hook invocations (R7/D-49-01)', () => {
  it('SAME window token + DIFFERENT pids -> SAME terminalId (kills per-invocation fragmentation)', () => {
    const a = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 100, sessionToken: 'sess-1' })
    const b = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 200, sessionToken: 'sess-1' })
    expect(a.terminalId).toBe(b.terminalId) // one window -> one identity across hook processes
    expect(a.sessionToken).toBe('sess-1')
  })

  it('SAME name but DIFFERENT window tokens -> DISTINCT terminalIds (WR-05 concurrent windows preserved)', () => {
    const a = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 100, sessionToken: 'sess-A' })
    const b = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 100, sessionToken: 'sess-B' })
    expect(a.terminalId).not.toBe(b.terminalId)
  })

  it('token beats pid: a NAMELESS terminal gets a STABLE T-<hash> id (not per-invocation T-<pid>)', () => {
    const a = resolveTerminalIdentity({ env: {}, pid: 100, sessionToken: 'sess-1' })
    const b = resolveTerminalIdentity({ env: {}, pid: 999, sessionToken: 'sess-1' })
    expect(a.terminalId).toBe(b.terminalId)
    expect(a.holderIdentity).toBe(b.holderIdentity) // stable fallback NAME too
    expect(a.terminalId).not.toBe('t-100') // no longer pid-derived
  })

  it('SMA_WINDOW_TOKEN and CLAUDE_SESSION_ID env are honored (same token -> same id, any pid/source)', () => {
    const viaWindow = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec', SMA_WINDOW_TOKEN: 'sess-1' }, pid: 5 })
    const viaClaude = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec', CLAUDE_SESSION_ID: 'sess-1' }, pid: 9 })
    expect(viaWindow.terminalId).toBe(viaClaude.terminalId)
  })

  it('no token anywhere -> the volatile pid tiebreaker still applies (WR-05 manual-run case)', () => {
    const a = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 100 })
    const b = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 200 })
    expect(a.terminalId).toBe('exec-100')
    expect(b.terminalId).toBe('exec-200')
  })
})

describe('heartbeat — two sequential hook invocations of ONE window renew ONE lease (R7 regression)', () => {
  it('same window token, DIFFERENT pids -> ONE file, throttle hits, then renews + transitions++', () => {
    // Simulate the production seam: two one-shot hook processes with distinct pids but the
    // SAME Claude session_id. Pre-fix this minted two write-once files; now it must be one.
    const idA = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 100, sessionToken: 'sess-1' })
    const idB = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 200, sessionToken: 'sess-1' })
    expect(idA.terminalId).toBe(idB.terminalId)

    const t0 = Date.parse('2026-07-03T10:00:00.000Z')
    const r1 = heartbeat(
      { scope: { globs: [], description: '' }, status: 'working' },
      { sessionsDir, identity: idA, now: t0 },
    )
    expect(r1.skipped).toBeFalsy()

    // second hook process (different pid) within the interval, unchanged -> throttle skip
    const r2 = heartbeat(
      { scope: { globs: [], description: '' }, status: 'working' },
      { sessionsDir, identity: idB, now: t0 + 1000 },
    )
    expect(r2.skipped).toBe(true)
    expect(readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))).toHaveLength(1)

    // third invocation AFTER the interval with a NEW scope -> renews the SAME file
    const before = JSON.parse(readFileSync(join(sessionsDir, `${idA.terminalId}.json`), 'utf8'))
    const r3 = heartbeat(
      { scope: { globs: ['src/**'], description: 'edit' }, status: 'working' },
      { sessionsDir, identity: idB, now: t0 + HEARTBEAT_INTERVAL_MS + 1000 },
    )
    expect(r3.skipped).toBeFalsy()
    expect(readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))).toHaveLength(1) // STILL one
    const after = JSON.parse(readFileSync(join(sessionsDir, `${idA.terminalId}.json`), 'utf8'))
    expect(Date.parse(after.renewTime)).toBeGreaterThan(Date.parse(before.renewTime)) // renewed
    expect(after.transitions).toBe(1) // scope changed exactly once
    expect(after.acquireTime).toBe(before.acquireTime) // acquire preserved across the window
  })

  it('two DIFFERENT windows sharing a name (distinct tokens) -> TWO lease files (WR-05 both directions)', () => {
    const idA = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 100, sessionToken: 'sess-A' })
    const idB = resolveTerminalIdentity({ env: { SMA_TERMINAL_NAME: 'exec' }, pid: 100, sessionToken: 'sess-B' })
    const t0 = Date.parse('2026-07-03T10:00:00.000Z')
    heartbeat({ scope: { globs: [], description: '' }, status: 'working' }, { sessionsDir, identity: idA, now: t0 })
    heartbeat({ scope: { globs: [], description: '' }, status: 'working' }, { sessionsDir, identity: idB, now: t0 })
    expect(readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))).toHaveLength(2)
  })
})

describe('heartbeat — clean dir creates full B15 lease (Test 1)', () => {
  it('writes <terminalId>.json with every B15 key', () => {
    const res = heartbeat(
      { scope: { globs: ['src/**'], description: 'edit' }, status: 'working', blockers: [] },
      { sessionsDir, identity: { holderIdentity: 'Мозг', terminalId: 'mozg', pid: 111 } },
    )
    expect(res.skipped).toBeFalsy()

    const raw = readFileSync(join(sessionsDir, 'mozg.json'), 'utf8')
    const lease = JSON.parse(raw)
    for (const k of B15_KEYS) expect(lease).toHaveProperty(k)
    expect(lease.holderIdentity).toBe('Мозг')
    expect(lease.pid).toBe(111)
    expect(lease.scope).toEqual({ globs: ['src/**'], description: 'edit' })
    expect(lease.status).toBe('working')
    expect(lease.blockers).toEqual([])
    expect(lease.transitions).toBe(0)
    expect(lease.leaseDurationSeconds).toBe(SESSION_TTL_MS / 1000)
    expect(typeof lease.acquireTime).toBe('string')
    expect(typeof lease.renewTime).toBe('string')
  })
})

describe('heartbeat — throttle (Test 2, RESEARCH OQ2)', () => {
  it('skips the write within HEARTBEAT_INTERVAL_MS when scope/status unchanged', () => {
    const identity = { holderIdentity: 'Мозг', terminalId: 'mozg', pid: 111 }
    const scope = { globs: ['src/**'], description: 'edit' }
    heartbeat({ scope, status: 'working', blockers: [] }, { sessionsDir, identity })

    const first = readFileSync(join(sessionsDir, 'mozg.json'), 'utf8')
    const firstRenew = JSON.parse(first).renewTime

    // Second beat immediately after -> renewTime younger than interval -> skip.
    const res2 = heartbeat({ scope, status: 'working', blockers: [] }, { sessionsDir, identity })
    expect(res2.skipped).toBe(true)

    const second = JSON.parse(readFileSync(join(sessionsDir, 'mozg.json'), 'utf8'))
    expect(second.renewTime).toBe(firstRenew)
  })
})

describe('heartbeat — new scope bumps transitions, preserves acquireTime (Test 3, B28)', () => {
  it('increments transitions on scope change and keeps the original acquireTime', () => {
    const identity = { holderIdentity: 'Мозг', terminalId: 'mozg', pid: 111 }
    heartbeat(
      { scope: { globs: ['src/**'], description: 'edit' }, status: 'working', blockers: [] },
      { sessionsDir, identity },
    )
    const first = JSON.parse(readFileSync(join(sessionsDir, 'mozg.json'), 'utf8'))

    const res2 = heartbeat(
      { scope: { globs: ['docs/**'], description: 'docs' }, status: 'working', blockers: [] },
      { sessionsDir, identity },
    )
    expect(res2.skipped).toBeFalsy()

    const second = JSON.parse(readFileSync(join(sessionsDir, 'mozg.json'), 'utf8'))
    expect(second.transitions).toBe(1)
    expect(second.acquireTime).toBe(first.acquireTime)
    expect(second.scope).toEqual({ globs: ['docs/**'], description: 'docs' })
  })
})

describe('heartbeat + readSessions — fail-open (Test 4, P4)', () => {
  it('a file where the sessions dir should be -> safe results, never throws', () => {
    // Point sessionsDir at a regular FILE, not a dir.
    const filePath = join(sessionsDir, 'notadir')
    writeFileSync(filePath, 'x')

    expect(() =>
      heartbeat(
        { scope: { globs: [], description: '' }, status: 'idle', blockers: [] },
        { sessionsDir: filePath, identity: { holderIdentity: 'Мозг', terminalId: 'mozg', pid: 111 } },
      ),
    ).not.toThrow()

    const out = readSessions({ sessionsDir: filePath })
    expect(Array.isArray(out.sessions)).toBe(true)
  })

  it('malformed JSON inside a session file is skipped, never throws', () => {
    writeFileSync(join(sessionsDir, 'broken.json'), '{ not json')
    const out = readSessions({ sessionsDir })
    expect(out.sessions).toEqual([])
    expect(out.corrupt).toBe(1)
  })
})

describe('readSessions — duplicate holderIdentity (Test 5, concurrency R7)', () => {
  it('flags a duplicate-identity WARN naming both pids', () => {
    const mk = (pid: number) => ({
      holderIdentity: 'Мозг',
      pid,
      scope: { globs: [], description: '' },
      status: 'working',
      blockers: [],
      acquireTime: '2026-07-02T10:00:00.000Z',
      renewTime: '2026-07-02T10:00:00.000Z',
      leaseDurationSeconds: 1800,
      transitions: 0,
    })
    writeFileSync(join(sessionsDir, 'mozg.json'), JSON.stringify(mk(111)))
    writeFileSync(join(sessionsDir, 'mozg-2.json'), JSON.stringify(mk(222)))

    const out = readSessions({ sessionsDir })
    expect(out.sessions).toHaveLength(2)
    expect(out.warnings.length).toBeGreaterThanOrEqual(1)
    const dup = out.warnings.find((w: any) => w.type === 'duplicate-identity')
    expect(dup).toBeTruthy()
    expect(dup.holderIdentity).toBe('Мозг')
    expect(dup.pids).toEqual(expect.arrayContaining([111, 222]))
  })
})

describe('classifyStaleness — graduated grading (Test 6, D-49-11, P3)', () => {
  const base = {
    holderIdentity: 'Мозг',
    pid: 111,
    scope: { globs: ['src/**'], description: 'edit' },
    status: 'working',
    blockers: [],
    acquireTime: '2026-07-02T10:00:00.000Z',
    leaseDurationSeconds: SESSION_TTL_MS / 1000,
    transitions: 0,
  }
  const now = Date.parse('2026-07-02T12:00:00.000Z')

  it('fresh when renewTime is recent', () => {
    const s = { ...base, renewTime: new Date(now - 1000).toISOString() }
    const r = classifyStaleness(s, { now })
    expect(r.state).toBe('fresh')
  })

  it('attention after ~3 missed beats', () => {
    const age = ATTENTION_AFTER_MISSES * HEARTBEAT_INTERVAL_MS + 1000
    const s = { ...base, renewTime: new Date(now - age).toISOString() }
    const r = classifyStaleness(s, { now })
    expect(r.state).toBe('attention')
  })

  it('reap-eligible (clean) after TTL + grace with no fresh mtimes in scope', () => {
    const age = SESSION_TTL_MS + GRACE_MS + 1000
    const s = { ...base, renewTime: new Date(now - age).toISOString() }
    const r = classifyStaleness(s, { now, scopeMtimeProbe: () => now - age }) // all files older than renewTime
    expect(r.state).toBe('reap-clean')
  })

  it('reap-eligible but DIRTY (fresh mtimes in scope) -> needs-human, never deleted', () => {
    const age = SESSION_TTL_MS + GRACE_MS + 1000
    const s = { ...base, renewTime: new Date(now - age).toISOString() }
    const r = classifyStaleness(s, { now, scopeMtimeProbe: () => now - 1000 }) // fresh file mtime
    expect(r.state).toBe('needs-human')
    expect(r.dirty).toBe(true)
  })
})

describe('reapStale — removes only clean stale entries (P3)', () => {
  it('removes reap-clean entries and leaves dirty/fresh ones', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const staleAge = SESSION_TTL_MS + GRACE_MS + 1000
    const mk = (id: string, renewMs: number) => ({
      holderIdentity: id,
      pid: 111,
      scope: { globs: [], description: '' },
      status: 'idle',
      blockers: [],
      acquireTime: '2026-07-02T10:00:00.000Z',
      renewTime: new Date(renewMs).toISOString(),
      leaseDurationSeconds: SESSION_TTL_MS / 1000,
      transitions: 0,
    })
    writeFileSync(join(sessionsDir, 'clean.json'), JSON.stringify(mk('clean', now - staleAge)))
    writeFileSync(join(sessionsDir, 'fresh.json'), JSON.stringify(mk('fresh', now - 1000)))

    const res = reapStale({ sessionsDir, now, dryRun: false, scopeMtimeProbe: () => now - staleAge })
    const remaining = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))
    expect(remaining).toContain('fresh.json')
    expect(remaining).not.toContain('clean.json')
    expect(res.reaped).toContain('clean')
  })

  it('dryRun never deletes', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const staleAge = SESSION_TTL_MS + GRACE_MS + 1000
    writeFileSync(
      join(sessionsDir, 'clean.json'),
      JSON.stringify({
        holderIdentity: 'clean',
        pid: 111,
        scope: { globs: [], description: '' },
        status: 'idle',
        blockers: [],
        acquireTime: '2026-07-02T10:00:00.000Z',
        renewTime: new Date(now - staleAge).toISOString(),
        leaseDurationSeconds: SESSION_TTL_MS / 1000,
        transitions: 0,
      }),
    )
    reapStale({ sessionsDir, now, dryRun: true, scopeMtimeProbe: () => now - staleAge })
    expect(readdirSync(sessionsDir)).toContain('clean.json')
  })
})

describe('heartbeat snapshot spawn — suppressed under the test runner (WR-10)', () => {
  it('does NOT spawn a real detached child under VITEST (no injected spawnFn)', () => {
    // VITEST is set during the suite, so the kill-switch inside spawnDetachedSnapshot
    // must short-circuit. We assert indirectly: with no spawnFn injected the beat still
    // succeeds and writes the lease, and (critically) no real child is launched. If a
    // real child were spawned it would read the real repo .sma/ — the WR-10 hazard.
    const identity = { holderIdentity: 'Мозг', terminalId: 'wr10a', pid: 111 }
    const res = heartbeat(
      { scope: { globs: ['src/**'], description: 'x' }, status: 'working' },
      { sessionsDir, identity }, // no spawnFn, no spawnSnapshot:false
    )
    expect(res.skipped).toBeFalsy()
    expect(readdirSync(sessionsDir)).toContain('wr10a.json')
  })

  it('an INJECTED spawnFn is still invoked (deterministic, no real process)', () => {
    let spawnCalls = 0
    const fakeSpawn = () => {
      spawnCalls += 1
      return { unref() {} }
    }
    const identity = { holderIdentity: 'Мозг', terminalId: 'wr10b', pid: 222 }
    heartbeat(
      { scope: { globs: ['src/**'], description: 'y' }, status: 'working' },
      { sessionsDir, identity, spawnFn: fakeSpawn },
    )
    expect(spawnCalls).toBe(1) // injected spawn still runs — behavior stays assertable
  })

  it('spawnSnapshot:false suppresses the injected spawn too', () => {
    let spawnCalls = 0
    const fakeSpawn = () => {
      spawnCalls += 1
      return { unref() {} }
    }
    const identity = { holderIdentity: 'Мозг', terminalId: 'wr10c', pid: 333 }
    heartbeat(
      { scope: { globs: ['src/**'], description: 'z' }, status: 'working' },
      { sessionsDir, identity, spawnFn: fakeSpawn, spawnSnapshot: false },
    )
    expect(spawnCalls).toBe(0)
  })
})

describe('resolveWorkLabel — precedence: claim scope > STATE phase > command (FI-10)', () => {
  it('Test 1a: an active claimed scope wins over everything', () => {
    const label = resolveWorkLabel({
      claimScope: 'правит slots.mjs',
      statePath: '/whatever/STATE.md',
      argv: ['sma-build', '49.1'],
      readFileFn: () => '## Current Position\nPhase: 49.1',
    })
    expect(label).toBe('правит slots.mjs')
  })

  it('Test 1b: no claim -> the STATE.md Current Position phase', () => {
    const label = resolveWorkLabel({
      statePath: '/whatever/STATE.md',
      argv: ['sma-build', '49.1'],
      readFileFn: () => '## Current Position\nPhase: 49.1 — SMA V2\n',
    })
    expect(label).toBe('phase:49.1')
  })

  it('Test 1c: no claim, no STATE phase -> the invoking command name', () => {
    const label = resolveWorkLabel({ argv: ['sma-discuss', '52'] })
    expect(label).toBe('sma-discuss')
  })

  it('nothing resolvable -> idle (fail-open)', () => {
    expect(resolveWorkLabel({})).toBe('idle')
    expect(resolveWorkLabel({ statePath: '/no/such/STATE.md' })).toBe('idle')
  })
})

describe('heartbeat — the work label lands + REFRESHES each call (FI-10, Test 1/2)', () => {
  it('Test 1: the label lands in the heartbeat record', () => {
    const identity = { holderIdentity: 'Tom', terminalId: 'tom', pid: 111 }
    heartbeat(
      { scope: { globs: ['scripts/**'], description: 'slots' }, status: 'working', label: 'phase:49.1' },
      { sessionsDir, identity },
    )
    const lease = JSON.parse(readFileSync(join(sessionsDir, 'tom.json'), 'utf8'))
    expect(lease.label).toBe('phase:49.1')
  })

  it('Test 2: a changed label forces a refresh even within the throttle interval', () => {
    const identity = { holderIdentity: 'Tom', terminalId: 'tom2', pid: 222 }
    const scope = { globs: ['scripts/**'], description: 'slots' }
    const t0 = Date.parse('2026-07-06T10:00:00.000Z')
    const r1 = heartbeat({ scope, status: 'working', label: 'phase:49.1' }, { sessionsDir, identity, now: t0 })
    expect(r1.skipped).toBeFalsy()

    // Within HEARTBEAT_INTERVAL_MS, same scope/status but a NEW label -> not throttled.
    const r2 = heartbeat({ scope, status: 'working', label: 'phase:52' }, { sessionsDir, identity, now: t0 + 1000 })
    expect(r2.skipped).toBeFalsy()
    const lease = JSON.parse(readFileSync(join(sessionsDir, 'tom2.json'), 'utf8'))
    expect(lease.label).toBe('phase:52') // label followed the work

    // Same label again within the interval -> throttle restored.
    const r3 = heartbeat({ scope, status: 'working', label: 'phase:52' }, { sessionsDir, identity, now: t0 + 2000 })
    expect(r3.skipped).toBe(true)
  })

  it('an omitted label PRESERVES the existing one (never blanks it)', () => {
    const identity = { holderIdentity: 'Tom', terminalId: 'tom3', pid: 333 }
    const t0 = Date.parse('2026-07-06T10:00:00.000Z')
    heartbeat(
      { scope: { globs: ['a/**'], description: 'a' }, status: 'working', label: 'phase:49.1' },
      { sessionsDir, identity, now: t0 },
    )
    // A later beat with a new scope but NO label keeps the prior label.
    heartbeat(
      { scope: { globs: ['b/**'], description: 'b' }, status: 'working' },
      { sessionsDir, identity, now: t0 + HEARTBEAT_INTERVAL_MS + 1000 },
    )
    const lease = JSON.parse(readFileSync(join(sessionsDir, 'tom3.json'), 'utf8'))
    expect(lease.label).toBe('phase:49.1')
  })
})

describe('displayIdentity — «P<phase> <Name>», graceful degradation (FI-10, Test 3)', () => {
  it('both parts known -> «P49 Tom»', () => {
    expect(displayIdentity({ holderIdentity: 'Tom', label: 'phase:49' })).toBe('P49 Tom')
  })

  it('accepts a dotted phase and a P-token label', () => {
    expect(displayIdentity({ holderIdentity: 'Angie', label: 'phase:51.2' })).toBe('P51.2 Angie')
    expect(displayIdentity({ holderIdentity: 'Tom', phase: '49.1' })).toBe('P49.1 Tom')
  })

  it('name unset (auto T- token) degrades to «P<phase>» — no anonymous token', () => {
    expect(displayIdentity({ holderIdentity: 'T-3bbdef7f', label: 'phase:52' })).toBe('P52')
  })

  it('name known but no phase -> just the name', () => {
    expect(displayIdentity({ holderIdentity: 'Tom' })).toBe('Tom')
  })
})

describe('buildJournalActors + a real journal event — who/what never empty (FI-10, Test 4)', () => {
  let journalDir: string
  beforeEach(() => {
    journalDir = mkdtempSync(join(tmpdir(), 'sma-registry-journal-'))
  })
  afterEach(() => {
    rmSync(journalDir, { recursive: true, force: true })
  })

  it('a collision event records who:[selfIdentity, otherIdentity] and what:<path>', () => {
    const actors = buildJournalActors({
      self: { holderIdentity: 'Tom', label: 'phase:49' },
      other: { holderIdentity: 'Angie', label: 'phase:51' },
    })
    expect(actors).toEqual(['P49 Tom', 'P51 Angie'])

    appendEvent(
      { type: 'collision', actors, scope: 'src/crm/orchestrator/router.ts' },
      { terminalId: 'tom', journalDir },
    )
    const [evt] = journalTail('tom', 1, { journalDir })
    expect(evt.actors).toEqual(['P49 Tom', 'P51 Angie']) // who column populated (both terminals)
    expect(evt.scope).toBe('src/crm/orchestrator/router.ts') // what path populated
    expect(evt.actors.length).toBeGreaterThan(0)
  })
})

describe('probeScopeMtime — only matching globs, skips heavy dirs (WR-01)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sma-probe-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('considers ONLY files matching a claimed glob, not the whole tree', () => {
    // In-scope file is OLD; an out-of-scope file (docs/) is NEW. The probe must
    // return the in-scope mtime, not the newest-anywhere mtime (the WR-01 bug).
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    const oldMs = Date.parse('2026-07-01T00:00:00.000Z')
    const newMs = Date.parse('2026-07-02T12:00:00.000Z')
    writeFileSync(join(root, 'src', 'a.ts'), 'x')
    writeFileSync(join(root, 'docs', 'b.md'), 'y')

    const statFn = (p: string) => ({
      mtimeMs: p.replace(/\\/g, '/').includes('/src/') ? oldMs : newMs,
    })
    const session = { scope: { globs: ['src/**'], description: '' } }
    const max = probeScopeMtime(session, { root, statFn: statFn as any })
    expect(max).toBe(oldMs) // NOT newMs — the out-of-scope docs file is ignored
  })

  it('never recurses into .git / node_modules', () => {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'z')
    writeFileSync(join(root, '.git', 'HEAD'), 'ref')
    writeFileSync(join(root, 'src', 'a.ts'), 'x')

    const visited: string[] = []
    const readdirFn = (dir: string, o: any) => {
      visited.push(dir.replace(/\\/g, '/'))
      return readdirSync(dir, o)
    }
    const session = { scope: { globs: ['**'], description: '' } }
    probeScopeMtime(session, { root, readdirFn: readdirFn as any })
    expect(visited.some((d) => d.includes('/node_modules'))).toBe(false)
    expect(visited.some((d) => d.endsWith('/.git'))).toBe(false)
  })

  it('empty globs -> 0 (no work)', () => {
    expect(probeScopeMtime({ scope: { globs: [], description: '' } }, { root })).toBe(0)
  })
})
