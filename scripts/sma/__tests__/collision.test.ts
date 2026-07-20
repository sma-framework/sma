/**
 * Tests for scripts/sma/lib/collision.mjs (Phase 49 Plan 05, Task 2).
 *
 * R8 advisory scope-glob collision detector (B20/B25, D-9-16):
 *   - Test 1: normalizePath case-folds + slash-normalizes BEFORE any matching
 *     (SPEC edge: encoding R8).
 *   - Test 2: a path inside another session's claimed glob -> one WARN with
 *     {who, pid, operation, scope, since, howToClear}; caller NOT blocked.
 *   - Test 3: empty registry / no scopes -> [] with no side effects (empty R8).
 *   - Test 4: the WARN emission path (recordCollisions) appends a 'collision'
 *     journal event with actors + ts.
 *   - Test 5: an aged-out DIRTY owner in the intersection is annotated
 *     'needs-human', not removed (P3).
 *   - Test 6 (D-9-16): a HOT_FILES path with >=2 fresh sessions + NO claim ->
 *     an informational (tier:'info') warn; 1 session -> none; info never counted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizePath,
  compileGlob,
  checkScopeCollision,
  relativizePath,
  buildWarnText,
  recordCollisions,
  HOT_FILES,
} from '../lib/collision.mjs'
import { SESSION_TTL_MS, GRACE_MS } from '../lib/constants.mjs'

const iso = (ms: number) => new Date(ms).toISOString()

function mkSession(over: Partial<any> = {}) {
  const now = Date.parse('2026-07-02T12:00:00.000Z')
  return {
    holderIdentity: 'Фабрика',
    pid: 31240,
    scope: { globs: ['src/**'], description: 'push' },
    status: 'working',
    blockers: [],
    acquireTime: '2026-07-02T11:20:00.000Z',
    renewTime: iso(now - 1000),
    leaseDurationSeconds: SESSION_TTL_MS / 1000,
    transitions: 0,
    _file: 'fabrika.json',
    ...over,
  }
}

describe('normalizePath (encoding R8)', () => {
  it('maps a Windows-cased backslash path and a lower forward-slash path to the same string', () => {
    const a = normalizePath('C:\\Repo\\SRC\\File.TS')
    const b = normalizePath('c:/repo/src/file.ts')
    expect(a).toBe(b)
  })

  it('collapses duplicate slashes', () => {
    expect(normalizePath('src//lib///x.ts')).toBe('src/lib/x.ts')
  })
})

describe('compileGlob (minimal subset **, *, literal)', () => {
  it('** matches across path segments; * stays within one segment', () => {
    const deep = compileGlob('src/**')
    expect(deep.test(normalizePath('src/a/b/c.ts'))).toBe(true)
    const oneSeg = compileGlob('src/*.ts')
    expect(oneSeg.test(normalizePath('src/x.ts'))).toBe(true)
    expect(oneSeg.test(normalizePath('src/a/x.ts'))).toBe(false)
  })
})

describe('checkScopeCollision — foreign glob hit (Test 2, B25)', () => {
  it('returns one WARN with the full payload and does not block', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const sessions = [mkSession()]
    const warns = checkScopeCollision(['src/crm/x.ts'], { sessions, selfTerminalId: 'mozg', now })
    const collision = warns.find((w: any) => w.tier === 'warn')
    expect(collision).toBeTruthy()
    expect(collision.who).toBe('Фабрика')
    expect(collision.pid).toBe(31240)
    expect(collision.operation).toBe('push')
    expect(collision.scope).toBe('src/**')
    expect(typeof collision.since).toBe('string')
    expect(typeof collision.howToClear).toBe('string')
    expect(collision.howToClear.length).toBeGreaterThan(0)
  })

  it('does NOT warn on the session own terminal (self)', () => {
    // self detection is by terminalId derived from the session file name.
    const sessions = [mkSession({ _file: 'mozg.json', holderIdentity: 'Мозг' })]
    const warns = checkScopeCollision(['src/crm/x.ts'], {
      sessions,
      selfTerminalId: 'mozg', // matches terminalId from 'mozg.json'
      now: Date.parse('2026-07-02T12:00:00.000Z'),
    })
    const collision = warns.find((w: any) => w.tier === 'warn')
    expect(collision).toBeFalsy()
  })
})

describe('checkScopeCollision — absolute hook paths vs. relative globs (CR-01)', () => {
  // Claude Code PreToolUse delivers ABSOLUTE file_path values; the fix relativizes
  // them against the repo root before matching the repo-relative globs + HOT_FILES.
  const REPO_ROOT = 'C:\\Users\\dev\\projects\\example-app'

  it('an absolute Windows path inside a foreign relative glob fires the collision WARN', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const sessions = [mkSession()] // scope.globs: ['src/**']
    const abs = `${REPO_ROOT}\\src\\crm\\foo.ts` // exactly as the hook delivers it
    const warns = checkScopeCollision([abs], {
      sessions,
      selfTerminalId: 'mozg',
      now,
      root: REPO_ROOT,
    })
    const collision = warns.find((w: any) => w.tier === 'warn')
    expect(collision).toBeTruthy()
    expect(collision.scope).toBe('src/**')
    expect(collision.who).toBe('Фабрика')
  })

  it('WITHOUT the root option the absolute path never matches (documents the CR-01 bug)', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const abs = `${REPO_ROOT}\\src\\crm\\foo.ts`
    const warns = checkScopeCollision([abs], { sessions: [mkSession()], selfTerminalId: 'mozg', now })
    expect(warns.filter((w: any) => w.tier === 'warn')).toHaveLength(0)
  })

  it('a forward-slash absolute path is relativized too (case-insensitive drive)', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const abs = 'c:/Users/dev/projects/example-app/src/x.ts'
    const warns = checkScopeCollision([abs], {
      sessions: [mkSession()],
      selfTerminalId: 'mozg',
      now,
      root: REPO_ROOT, // different case than the candidate — NTFS is case-insensitive
    })
    expect(warns.filter((w: any) => w.tier === 'warn')).toHaveLength(1)
  })

  it('an absolute HOT_FILES path with >=2 fresh sessions fires the hot-file advisory', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const s1 = mkSession({ _file: 'fabrika.json', scope: { globs: [], description: '' }, renewTime: iso(now - 1000) })
    const s2 = mkSession({ holderIdentity: 'Мозг', _file: 'mozg2.json', pid: 999, scope: { globs: [], description: '' }, renewTime: iso(now - 1000) })
    const abs = `${REPO_ROOT}\\.planning\\STATE.md`
    const warns = checkScopeCollision([abs], { sessions: [s1, s2], selfTerminalId: 'other', now, root: REPO_ROOT })
    expect(warns.find((w: any) => w.tier === 'info' && w.reason === 'hot-file')).toBeTruthy()
  })

  it('a pure-relative input still matches when root is supplied (no regression)', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const warns = checkScopeCollision(['src/crm/x.ts'], {
      sessions: [mkSession()],
      selfTerminalId: 'mozg',
      now,
      root: REPO_ROOT,
    })
    expect(warns.filter((w: any) => w.tier === 'warn')).toHaveLength(1)
  })

  it('relativizePath strips the normalized root prefix and passes relative paths through', () => {
    const rootNorm = normalizePath(REPO_ROOT) + '/'
    expect(relativizePath(normalizePath(`${REPO_ROOT}\\src\\x.ts`), rootNorm)).toBe('src/x.ts')
    expect(relativizePath('src/x.ts', rootNorm)).toBe('src/x.ts')
    expect(relativizePath('src/x.ts', '')).toBe('src/x.ts')
  })
})

describe('checkScopeCollision — empty (Test 3, empty R8)', () => {
  it('empty registry / no scopes -> [] with no side effects', () => {
    expect(checkScopeCollision(['src/x.ts'], { sessions: [], selfTerminalId: 'mozg' })).toEqual([])
    const noScope = [mkSession({ scope: { globs: [], description: '' } })]
    expect(checkScopeCollision(['src/x.ts'], { sessions: noScope, selfTerminalId: 'mozg' })).toEqual([])
  })
})

describe('recordCollisions — journals each warn (Test 4, R10)', () => {
  let journalDir: string
  beforeEach(() => {
    journalDir = mkdtempSync(join(tmpdir(), 'sma-collision-'))
  })
  afterEach(() => {
    rmSync(journalDir, { recursive: true, force: true })
  })

  it('appends a collision event with actors + ts per warn', () => {
    const warns = checkScopeCollision(['src/crm/x.ts'], {
      sessions: [mkSession()],
      selfTerminalId: 'mozg',
      now: Date.parse('2026-07-02T12:00:00.000Z'),
    }).filter((w: any) => w.tier === 'warn')

    recordCollisions(warns, { terminalId: 'mozg', journalDir })
    const files = readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'))
    expect(files).toContain('mozg.jsonl')
    const line = JSON.parse(readFileSync(join(journalDir, 'mozg.jsonl'), 'utf8').trim().split('\n')[0])
    expect(line.type).toBe('collision')
    expect(Array.isArray(line.actors)).toBe(true)
    expect(line.actors).toEqual(expect.arrayContaining(['mozg', 'Фабрика']))
    expect(typeof line.ts).toBe('string')
  })
})

describe('checkScopeCollision — aged-out dirty owner (Test 5, P3)', () => {
  it('annotates a stale dirty owner as needs-human, never removes', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const staleAge = SESSION_TTL_MS + GRACE_MS + 1000
    const stale = mkSession({ renewTime: iso(now - staleAge) })
    const warns = checkScopeCollision(['src/crm/x.ts'], {
      sessions: [stale],
      selfTerminalId: 'mozg',
      now,
      scopeMtimeProbe: () => now - 1000, // fresh mtime -> dirty
    })
    const collision = warns.find((w: any) => w.tier === 'warn')
    expect(collision).toBeTruthy()
    expect(collision.staleness).toBe('needs-human')
  })
})

describe('HOT_FILES (D-9-16)', () => {
  it('exports the built-in hot-file watch list containing the three planning files', () => {
    expect(HOT_FILES).toEqual(
      expect.arrayContaining([
        normalizePath('.planning/STATE.md'),
        normalizePath('.planning/ROADMAP.md'),
        normalizePath('.claude/memory/MEMORY.md'),
      ]),
    )
  })

  it('a hot-file path with >=2 fresh sessions and NO claim -> an info warn, never a collision', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const s1 = mkSession({ holderIdentity: 'Фабрика', _file: 'fabrika.json', scope: { globs: [], description: '' }, renewTime: iso(now - 1000) })
    const s2 = mkSession({ holderIdentity: 'Мозг', _file: 'mozg2.json', pid: 999, scope: { globs: [], description: '' }, renewTime: iso(now - 1000) })
    const warns = checkScopeCollision(['.planning/STATE.md'], {
      sessions: [s1, s2],
      selfTerminalId: 'other',
      now,
    })
    const info = warns.find((w: any) => w.tier === 'info' && w.reason === 'hot-file')
    expect(info).toBeTruthy()
    expect(info.text).toMatch(/сесси/i)
    // info warns are NOT collisions
    expect(warns.filter((w: any) => w.tier === 'warn')).toHaveLength(0)
  })

  it('a hot-file path with only 1 active session -> no info warn', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const s1 = mkSession({ scope: { globs: [], description: '' }, renewTime: iso(now - 1000) })
    const warns = checkScopeCollision(['.planning/STATE.md'], {
      sessions: [s1],
      selfTerminalId: 'other',
      now,
    })
    expect(warns.filter((w: any) => w.reason === 'hot-file')).toHaveLength(0)
  })
})

describe('buildWarnText (B25 completeness, Terraform style)', () => {
  it('renders the RU one-liner carrying holder, pid, operation, since, and how-to-clear', () => {
    const warn = {
      tier: 'warn',
      who: 'Фабрика',
      pid: 31240,
      operation: 'push',
      scope: 'src/**',
      since: '2026-07-02T11:20:00.000Z',
      howToClear: 'pnpm sma force-clear push',
    }
    const text = buildWarnText(warn)
    expect(text).toContain('Фабрика')
    expect(text).toContain('31240')
    expect(text).toContain('push')
    expect(text).toContain('force-clear')
  })

  it('passes an info hot-file warn through as its text', () => {
    const info = { tier: 'info', reason: 'hot-file', text: '2 сессии активны; файл высококонтентный; перечитайте перед записью' }
    expect(buildWarnText(info)).toBe(info.text)
  })
})
