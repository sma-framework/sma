/**
 * Tests for the capability envelope — what a task may touch, declared and validated.
 * This is the fleet's second invariant made executable.
 *
 * The law under test: a task's reach is bounded by a DECLARATION, not by convention.
 * Every task carries an envelope naming what it may read, write, run, reach, spend and
 * how long it may run — and no construction of those inputs can produce push or merge.
 *
 * The posture is `schema-v2.mjs`'s: a frozen closed vocabulary plus a pure, fail-closed
 * resolver. Missing key, unknown key, a declared human-only action — all refusals, each
 * naming its reason. An envelope that cannot be read grants nothing.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  CAPABILITY_KEYS,
  HUMAN_ONLY_ACTIONS,
  ENVELOPE_LANES,
  defaultEnvelope,
  validateEnvelope,
  envelopeAllows,
  envelopeHash,
} from '../src/queue/capability-envelope.mjs'
import { TASK_LANES } from '../src/queue/adapter.mjs'

const src = readFileSync(new URL('../src/queue/capability-envelope.mjs', import.meta.url), 'utf8')

describe('CAPABILITY_KEYS — the fleet’s eight dimensions, frozen', () => {
  it('holds exactly eight dimensions and is frozen', () => {
    expect(CAPABILITY_KEYS).toHaveLength(8)
    expect(Object.isFrozen(CAPABILITY_KEYS)).toBe(true)
  })

  it('names the fleet’s dimensions: read/write paths, tools, network, secrets, budget, runtime, human-only', () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual(
      [
        'allowedTools',
        'budget',
        'humanOnlyActions',
        'maxRuntime',
        'networkDestinations',
        'readPaths',
        'secretScopes',
        'writePaths',
      ].sort(),
    )
  })

  it('the lane vocabulary is the task shape’s, not a second one (adapter.mjs TASK_LANES)', () => {
    expect([...ENVELOPE_LANES]).toEqual([...TASK_LANES])
    expect(Object.isFrozen(ENVELOPE_LANES)).toBe(true)
  })

  it('push and merge are permanently in the human-only set', () => {
    expect(HUMAN_ONLY_ACTIONS).toContain('push')
    expect(HUMAN_ONLY_ACTIONS).toContain('merge')
    expect(Object.isFrozen(HUMAN_ONLY_ACTIONS)).toBe(true)
  })
})

describe('defaultEnvelope — a complete envelope for every lane', () => {
  it('every lane gets an envelope with every key present, and it validates', () => {
    for (const lane of ENVELOPE_LANES) {
      const env = defaultEnvelope(lane)
      for (const key of CAPABILITY_KEYS) {
        expect(Object.hasOwn(env, key), `${lane} is missing ${key}`).toBe(true)
      }
      expect(Object.keys(env).sort()).toEqual([...CAPABILITY_KEYS].sort())
      expect(validateEnvelope(env).valid, `${lane} envelope must validate`).toBe(true)
    }
  })

  it('EVERY lane denies push and denies merge (fleet invariant 2)', () => {
    for (const lane of ENVELOPE_LANES) {
      const env = defaultEnvelope(lane)
      expect(env.humanOnlyActions, `${lane}`).toContain('push')
      expect(env.humanOnlyActions, `${lane}`).toContain('merge')
      expect(envelopeAllows(env, { action: 'push' }), `${lane}`).toBe(false)
      expect(envelopeAllows(env, { action: 'merge' }), `${lane}`).toBe(false)
      // and no granting dimension names either capability
      const granting = [...env.readPaths, ...env.writePaths, ...env.allowedTools, ...env.networkDestinations, ...env.secretScopes]
      for (const entry of granting) {
        expect(String(entry).toLowerCase()).not.toContain('push')
        expect(String(entry).toLowerCase()).not.toContain('merge')
      }
    }
  })

  it('the lanes differ where they really differ — the write scope', () => {
    const write = (lane: string) => defaultEnvelope(lane).writePaths.join('|')
    expect(write('forge')).not.toBe(write('prod'))
    expect(write('research')).not.toBe(write('prod'))
    // the forge drafts into the three draft dirs the forge module already contracts
    expect(defaultEnvelope('forge').writePaths).toEqual([
      '.claude/agents',
      '.claude/skills',
      '.claude/harness/mcp-requests',
    ])
  })

  it('an unknown lane gets the LOCKED envelope, not a permissive default (fail-closed)', () => {
    const env = defaultEnvelope('whatever-the-prompt-said')
    expect(validateEnvelope(env).valid).toBe(true)
    expect(env.writePaths).toEqual([])
    expect(env.allowedTools).toEqual([])
    expect(envelopeAllows(env, { action: 'write', path: 'src/x.mjs' })).toBe(false)
    expect(defaultEnvelope(undefined).writePaths).toEqual([])
  })

  it('the returned envelope is frozen — a caller cannot widen its own permit in place', () => {
    const env = defaultEnvelope('prod')
    expect(Object.isFrozen(env)).toBe(true)
    expect(Object.isFrozen(env.writePaths)).toBe(true)
  })
})

describe('validateEnvelope — fail-closed, and it names the reason', () => {
  it('accepts a complete envelope', () => {
    const res = validateEnvelope(defaultEnvelope('prod'))
    expect(res.valid).toBe(true)
    expect(res.refusal).toBeNull()
  })

  it('refuses a missing key and NAMES the missing key', () => {
    for (const key of CAPABILITY_KEYS) {
      const env: any = { ...defaultEnvelope('prod') }
      delete env[key]
      const res = validateEnvelope(env)
      expect(res.valid, `${key} must be required`).toBe(false)
      expect(res.refusal).toContain(key)
      expect(res.key).toBe(key)
    }
  })

  it('refuses an UNKNOWN key rather than ignoring it — an unrecognised permission is not a permit', () => {
    const env: any = { ...defaultEnvelope('prod'), canDoAnything: ['everything'] }
    const res = validateEnvelope(env)
    expect(res.valid).toBe(false)
    expect(res.refusal).toContain('canDoAnything')
    expect(res.key).toBe('canDoAnything')
  })

  it('refuses an envelope that declares a push capability, naming the human-only boundary', () => {
    const env: any = { ...defaultEnvelope('prod'), allowedTools: ['Read', 'GitPush'] }
    const res = validateEnvelope(env)
    expect(res.valid).toBe(false)
    expect(res.refusal).toMatch(/human-only/i)
    expect(res.refusal).toMatch(/push/i)
  })

  it('refuses a declared merge capability the same way, whatever else the envelope says', () => {
    const env: any = { ...defaultEnvelope('research'), networkDestinations: ['merge.internal'] }
    const res = validateEnvelope(env)
    expect(res.valid).toBe(false)
    expect(res.refusal).toMatch(/human-only/i)
  })

  it('the human-only check runs FIRST — a malformed envelope still cannot smuggle push through', () => {
    const res = validateEnvelope({ allowedTools: ['push-to-origin'] } as any)
    expect(res.valid).toBe(false)
    expect(res.refusal).toMatch(/human-only/i)
  })

  it('refuses an envelope whose humanOnlyActions dropped push or merge — no input moves them out', () => {
    for (const dropped of ['push', 'merge']) {
      const base = defaultEnvelope('prod')
      const env: any = { ...base, humanOnlyActions: base.humanOnlyActions.filter((a: string) => a !== dropped) }
      const res = validateEnvelope(env)
      expect(res.valid, `dropping ${dropped} must be refused`).toBe(false)
      expect(res.refusal).toMatch(/human-only/i)
      expect(res.refusal).toContain(dropped)
    }
  })

  it('refuses a non-object, a null and an array', () => {
    for (const bad of [null, undefined, 'prod', 42, ['readPaths']]) {
      expect(validateEnvelope(bad as any).valid).toBe(false)
    }
  })

  it('refuses a dimension of the wrong shape — a string where a list belongs', () => {
    const env: any = { ...defaultEnvelope('prod'), readPaths: 'everything' }
    const res = validateEnvelope(env)
    expect(res.valid).toBe(false)
    expect(res.key).toBe('readPaths')
  })

  it('refuses a maxRuntime that is not a duration, and a negative budget', () => {
    expect(validateEnvelope({ ...defaultEnvelope('prod'), maxRuntime: 'forever' } as any).valid).toBe(false)
    expect(validateEnvelope({ ...defaultEnvelope('prod'), budget: -1 } as any).valid).toBe(false)
    expect(validateEnvelope({ ...defaultEnvelope('prod'), budget: 12.5 } as any).valid).toBe(true)
  })
})

describe('envelopeAllows — a permit is checked, never assumed', () => {
  const prod = defaultEnvelope('prod')
  const forge = defaultEnvelope('forge')

  it('returns false for a write OUTSIDE the declared write paths', () => {
    expect(envelopeAllows(forge, { action: 'write', path: '.claude/agents/x.md' })).toBe(true)
    expect(envelopeAllows(forge, { action: 'write', path: 'daemon/src/loop.mjs' })).toBe(false)
    expect(envelopeAllows(forge, { action: 'write', path: '.claude/agentsX/x.md' })).toBe(false) // boundary, not prefix
  })

  it('returns false for a network destination that is not declared', () => {
    expect(envelopeAllows(prod, { action: 'network', destination: 'api.example.com' })).toBe(false)
    const wired = { ...prod, networkDestinations: ['api.example.com'] }
    expect(envelopeAllows(wired, { action: 'network', destination: 'api.example.com' })).toBe(true)
    expect(envelopeAllows(wired, { action: 'network', destination: 'evil.example.com' })).toBe(false)
  })

  it('refuses a path escaping the declared root, however it is spelled', () => {
    expect(envelopeAllows(forge, { action: 'write', path: '.claude/agents/../../etc/passwd' })).toBe(false)
    expect(envelopeAllows(forge, { action: 'write', path: 'C:/Windows/system32' })).toBe(false)
    expect(envelopeAllows(forge, { action: 'write', path: '/etc/passwd' })).toBe(false)
    // Windows drive-RELATIVE — no slash after the colon. It resolves against the
    // drive's own cwd, outside any declared root; a slash-only test waves it
    // through as "relative", and prod declares writePaths: ['.'].
    expect(envelopeAllows(prod, { action: 'write', path: 'C:evil.txt' })).toBe(false)
    expect(envelopeAllows(forge, { action: 'write', path: 'c:.claude/agents/x.md' })).toBe(false)
  })

  it('returns false when the envelope itself is invalid — a malformed envelope grants nothing', () => {
    const broken: any = { ...prod }
    delete broken.writePaths
    expect(envelopeAllows(broken, { action: 'write', path: 'daemon/src/loop.mjs' })).toBe(false)
    expect(envelopeAllows(null as any, { action: 'read', path: 'README.md' })).toBe(false)
    expect(envelopeAllows({ allowedTools: ['Read'] } as any, { action: 'tool', tool: 'Read' })).toBe(false)
  })

  it('returns false for an unknown action — fail-closed on the verb too', () => {
    expect(envelopeAllows(prod, { action: 'exfiltrate', path: 'README.md' } as any)).toBe(false)
    expect(envelopeAllows(prod, {} as any)).toBe(false)
  })

  it('a declared human-only action is refused even when a dimension would allow it', () => {
    const smuggled: any = { ...prod, allowedTools: ['Read'] }
    expect(envelopeAllows(smuggled, { action: 'push' })).toBe(false)
    expect(envelopeAllows(smuggled, { action: 'merge' })).toBe(false)
  })

  it('a spend is refused when the envelope declares no budget of its own', () => {
    expect(prod.budget).toBeNull()
    expect(envelopeAllows(prod, { action: 'spend', amount: 1 })).toBe(false)
    const metered = { ...prod, budget: 5 }
    expect(envelopeAllows(metered, { action: 'spend', amount: 5 })).toBe(true)
    expect(envelopeAllows(metered, { action: 'spend', amount: 5.01 })).toBe(false)
  })

  it('a tool outside allowedTools is refused, one inside is allowed', () => {
    expect(envelopeAllows(prod, { action: 'tool', tool: 'Read' })).toBe(true)
    expect(envelopeAllows(prod, { action: 'tool', tool: 'WebFetch' })).toBe(false)
  })
})

describe('envelopeHash — a digest a receipt can be checked against', () => {
  it('is stable under key reordering', () => {
    const env: any = defaultEnvelope('prod')
    const reordered: any = {}
    for (const key of [...CAPABILITY_KEYS].reverse()) reordered[key] = env[key]
    expect(envelopeHash(reordered)).toBe(envelopeHash(env))
  })

  it('changes under ANY value change', () => {
    const base = defaultEnvelope('prod')
    const h = envelopeHash(base)
    expect(envelopeHash({ ...base, maxRuntime: '46m' })).not.toBe(h)
    expect(envelopeHash({ ...base, budget: 1 })).not.toBe(h)
    expect(envelopeHash({ ...base, writePaths: [...base.writePaths, 'extra'] })).not.toBe(h)
  })

  it('differs between lanes and is a fixed-length hex digest with no path separators', () => {
    const seen = new Set(ENVELOPE_LANES.map((l: string) => envelopeHash(defaultEnvelope(l))))
    expect(seen.size).toBeGreaterThan(1)
    for (const h of seen) {
      expect(h).toMatch(/^[0-9a-f]{64}$/)
      expect(h).not.toContain('/')
      expect(h).not.toContain('\\')
    }
  })

  it('is deterministic across calls and refuses to hash a non-object', () => {
    expect(envelopeHash(defaultEnvelope('research'))).toBe(envelopeHash(defaultEnvelope('research')))
    expect(() => envelopeHash(null as any)).toThrow()
  })
})

describe('the module keeps its stated disciplines', () => {
  it('imports NO backend — no pg, no pg-boss (BACKEND-FREE BY LAW)', () => {
    expect(src).not.toMatch(/from 'pg-boss'/)
    expect(src).not.toMatch(/from 'pg'/)
    expect(src).not.toMatch(/require\('pg/)
  })

  it('touches no filesystem and no network — node:crypto is the only import', () => {
    const imports = [...src.matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1])
    expect(imports).toEqual(['node:crypto'])
  })

  it('never writes the reserved push literal (SMA-3 comment discipline is not the point — the code is)', () => {
    expect(src).not.toMatch(/execSync|spawnSync|child_process/)
  })
})
