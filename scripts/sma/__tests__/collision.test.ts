/**
 * Tests for scripts/sma/lib/collision.mjs.
 *
 * R8 advisory scope-glob collision detector (B20/B25):
 *   - Test 1: normalizePath case-folds + slash-normalizes BEFORE any matching
 *     (SPEC edge: encoding R8).
 *   - Test 2: a path inside another session's claimed glob -> one WARN with
 *     {who, pid, operation, scope, since, howToClear}; caller NOT blocked.
 *   - Test 3: empty registry / no scopes -> [] with no side effects (empty R8).
 *   - Test 4: the WARN emission path (recordCollisions) appends a 'collision'
 *     journal event with actors + ts.
 *   - Test 5: an aged-out DIRTY owner in the intersection is annotated
 *     'needs-human', not removed (P3).
 *   - Test 6: a HOT_FILES path with >=2 fresh sessions + NO claim ->
 *     an informational (tier:'info') warn; 1 session -> none; info never counted.
 *   - Test 7: the claims-dir NAME derived from a scope description is distinct per
 *     description (a shared name lets one terminal clear another's reservation),
 *     readable, and compatible with directories left by the previous rule.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizePath,
  compileGlob,
  checkScopeCollision,
  relativizePath,
  buildWarnText,
  recordCollisions,
  scopeClaimSlug,
  HOT_FILES,
} from '../lib/collision.mjs'
import { claimSlot, readClaims, releaseSlot } from '../lib/claims.mjs'
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
    const warns = checkScopeCollision(['src/crm/x.ts'], { sessions, selfTerminalId: 'alpha', now })
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
    const sessions = [mkSession({ _file: 'alpha.json', holderIdentity: 'Мозг' })]
    const warns = checkScopeCollision(['src/crm/x.ts'], {
      sessions,
      selfTerminalId: 'alpha', // matches terminalId from 'alpha.json'
      now: Date.parse('2026-07-02T12:00:00.000Z'),
    })
    const collision = warns.find((w: any) => w.tier === 'warn')
    expect(collision).toBeFalsy()
  })
})

describe('checkScopeCollision — absolute hook paths vs. relative globs', () => {
  // Claude Code PreToolUse delivers ABSOLUTE file_path values; the fix relativizes
  // them against the repo root before matching the repo-relative globs + HOT_FILES.
  const REPO_ROOT = 'C:\\Users\\dev\\projects\\example-app'

  it('an absolute Windows path inside a foreign relative glob fires the collision WARN', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const sessions = [mkSession()] // scope.globs: ['src/**']
    const abs = `${REPO_ROOT}\\src\\crm\\foo.ts` // exactly as the hook delivers it
    const warns = checkScopeCollision([abs], {
      sessions,
      selfTerminalId: 'alpha',
      now,
      root: REPO_ROOT,
    })
    const collision = warns.find((w: any) => w.tier === 'warn')
    expect(collision).toBeTruthy()
    expect(collision.scope).toBe('src/**')
    expect(collision.who).toBe('Фабрика')
  })

  it('WITHOUT the root option the absolute path never matches (documents the original bug)', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const abs = `${REPO_ROOT}\\src\\crm\\foo.ts`
    const warns = checkScopeCollision([abs], { sessions: [mkSession()], selfTerminalId: 'alpha', now })
    expect(warns.filter((w: any) => w.tier === 'warn')).toHaveLength(0)
  })

  it('a forward-slash absolute path is relativized too (case-insensitive drive)', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const abs = 'c:/Users/dev/projects/example-app/src/x.ts'
    const warns = checkScopeCollision([abs], {
      sessions: [mkSession()],
      selfTerminalId: 'alpha',
      now,
      root: REPO_ROOT, // different case than the candidate — NTFS is case-insensitive
    })
    expect(warns.filter((w: any) => w.tier === 'warn')).toHaveLength(1)
  })

  it('an absolute HOT_FILES path with >=2 fresh sessions fires the hot-file advisory', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const s1 = mkSession({ _file: 'fabrika.json', scope: { globs: [], description: '' }, renewTime: iso(now - 1000) })
    const s2 = mkSession({ holderIdentity: 'Мозг', _file: 'alpha2.json', pid: 999, scope: { globs: [], description: '' }, renewTime: iso(now - 1000) })
    const abs = `${REPO_ROOT}\\.planning\\STATE.md`
    const warns = checkScopeCollision([abs], { sessions: [s1, s2], selfTerminalId: 'other', now, root: REPO_ROOT })
    expect(warns.find((w: any) => w.tier === 'info' && w.reason === 'hot-file')).toBeTruthy()
  })

  it('a pure-relative input still matches when root is supplied (no regression)', () => {
    const now = Date.parse('2026-07-02T12:00:00.000Z')
    const warns = checkScopeCollision(['src/crm/x.ts'], {
      sessions: [mkSession()],
      selfTerminalId: 'alpha',
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
    expect(checkScopeCollision(['src/x.ts'], { sessions: [], selfTerminalId: 'alpha' })).toEqual([])
    const noScope = [mkSession({ scope: { globs: [], description: '' } })]
    expect(checkScopeCollision(['src/x.ts'], { sessions: noScope, selfTerminalId: 'alpha' })).toEqual([])
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
      selfTerminalId: 'alpha',
      now: Date.parse('2026-07-02T12:00:00.000Z'),
    }).filter((w: any) => w.tier === 'warn')

    recordCollisions(warns, { terminalId: 'alpha', journalDir })
    const files = readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'))
    expect(files).toContain('alpha.jsonl')
    const line = JSON.parse(readFileSync(join(journalDir, 'alpha.jsonl'), 'utf8').trim().split('\n')[0])
    expect(line.type).toBe('collision')
    expect(Array.isArray(line.actors)).toBe(true)
    expect(line.actors).toEqual(expect.arrayContaining(['alpha', 'Фабрика']))
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
      selfTerminalId: 'alpha',
      now,
      scopeMtimeProbe: () => now - 1000, // fresh mtime -> dirty
    })
    const collision = warns.find((w: any) => w.tier === 'warn')
    expect(collision).toBeTruthy()
    expect(collision.staleness).toBe('needs-human')
  })
})

describe('HOT_FILES', () => {
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
    const s2 = mkSession({ holderIdentity: 'Мозг', _file: 'alpha2.json', pid: 999, scope: { globs: [], description: '' }, renewTime: iso(now - 1000) })
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

// ── the claims-dir name is a SAFETY surface, not cosmetics ────────────────────────
//
// The clearing command takes a NAME. When two DIFFERENT pieces of work are given the
// same name, clearing your own reservation quietly removes somebody else's — their
// files lose their guard while they are still being edited, and nothing says so. That
// is why this block asserts DISTINCTNESS (plus that the name stays readable to a
// human), NOT «the name became latin»: latin is the means, distinguishability is the
// property being bought.
//
// The last two cases prove the WIRE, not the computation: a real filesystem in a temp
// dir, the real claim primitives, one directory per description, and a clearing call
// that must land on exactly one of them. A name that is merely computed correctly and
// never reaches the disk buys nothing.
describe('claims-dir naming — two different descriptions never share one claim dir', () => {
  let claimsDir: string
  let tmpRoot: string
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sma-claim-slug-'))
    claimsDir = join(tmpRoot, 'claims')
  })
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  // The four strings below are the ones that actually collided in a live registry:
  // two whole-sentence descriptions collapsed to the bare word, and two different
  // pieces of work on the same numbered stretch collapsed to the number alone.
  const QUEUE = 'очередь без двойной выдачи'
  const BUDGET = 'подушка расхода бюджета'
  const STRETCH_A = 'выпуск 4.2 очередь'
  const STRETCH_B = 'выпуск 4.2 запуск'

  it('the four descriptions that collided in a live registry now give four different names', () => {
    const a = scopeClaimSlug(QUEUE)
    const b = scopeClaimSlug(BUDGET)
    const c = scopeClaimSlug(STRETCH_A)
    const d = scopeClaimSlug(STRETCH_B)
    expect(new Set([a, b, c, d]).size).toBe(4)
    // …and they are still READABLE: an operator has to recognise the work in the name
    // the clearing command prints, otherwise a distinct name is just a distinct riddle.
    expect(a).toContain('ochered')
    expect(b).toContain('podushka')
    expect(c).toContain('vypusk-4-2')
    expect(d).toContain('vypusk-4-2')
  })

  it('two descriptions in a script no latin name can carry are still told apart', () => {
    // Nothing survives the cleanup here, so the name cannot be built from the words.
    // The fallback appends a digest of the description — the one thing that is always
    // different when the descriptions are different.
    const a = scopeClaimSlug('队列不重复发放')
    const b = scopeClaimSlug('预算消耗缓冲')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^claim-[0-9a-f]{8}$/)
    expect(b).toMatch(/^claim-[0-9a-f]{8}$/)
  })

  it('clearing one reservation leaves the other reservation on disk', () => {
    const slugA = scopeClaimSlug(QUEUE)
    const slugB = scopeClaimSlug(BUDGET)

    expect(claimSlot(slugA, { by: 'терминал А' }, { claimsDir }).won).toBe(true)
    expect(claimSlot(slugB, { by: 'терминал Б' }, { claimsDir }).won).toBe(true)
    expect(readdirSync(claimsDir).sort()).toEqual([slugA, slugB].sort())

    const cleared = releaseSlot(slugA, { by: 'терминал А', force: true, claimsDir })
    expect(cleared.released).toBe(true)
    expect(existsSync(join(claimsDir, slugA))).toBe(false)
    expect(existsSync(join(claimsDir, slugB))).toBe(true) // the neighbour keeps its guard
  })

  it('a directory left by the previous naming rule is still listed and still clearable by its literal name', () => {
    // No migration is performed — nothing on disk is renamed or removed behind anyone's
    // back. Compatibility is bought by READING: whatever name a directory carries, the
    // listing shows it and the clearing command takes it verbatim.
    mkdirSync(join(claimsDir, 'claim'), { recursive: true })
    expect(readClaims({ claimsDir }).map((c) => c.name)).toContain('claim')
    expect(releaseSlot('claim', { by: 'любой терминал', force: true, claimsDir }).released).toBe(true)
    expect(existsSync(join(claimsDir, 'claim'))).toBe(false)
  })
})
