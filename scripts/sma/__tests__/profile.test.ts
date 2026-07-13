/**
 * Tests for scripts/sma/lib/profile.mjs (Phase 9.3 Plan 01, Task 2 — D-9.3-04/T-9.3-06).
 *
 * The deterministic profile library every later Track B command reads through:
 *   - Test 1 (tolerant read): a missing file → {} (never throws); corrupt JSON →
 *     {} plus a warnings entry; a valid v2 file round-trips.
 *   - Test 2 (v1 upgrade in memory): a v1 profile (no profileVersion) normalizes
 *     to the v2 shape WITHOUT rewriting the file — normalizeProfile is pure and
 *     never mutates its input; readProfile never writes.
 *   - Test 3 (schema): validateProfile flags an unknown top-level field and a
 *     wrong-typed field (riskTolerance: 7) with rule PROFILE-SCHEMA, each naming
 *     the field.
 *   - Test 4 (privacy): a planted secret-shaped VALUE (sk-/ghp_/AKIA/40+ char
 *     high-entropy blob) → PROFILE-SECRET; the literal NAME STRIPE_SECRET_KEY in
 *     envVarNames passes (names are facts, values are secrets).
 *   - Test 5 (dead fields): deadFields() returns [] on the shipped registry;
 *     dropping a consumer entry in a test copy makes its field appear.
 *   - Test 6 (coverage): answeredFields counts only fields the user answered;
 *     unset/absent never count.
 *   - Test 7 (recap determinism): renderRecap is pure — two calls with identical
 *     inputs return byte-identical strings; no timestamps; unset fields render as
 *     «not set — will ask when needed»; the five module one-liners come from the
 *     injected teachingSource's Recap: lines.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROFILE_SCHEMA,
  PROFILE_CONSUMERS,
  readProfile,
  normalizeProfile,
  validateProfile,
  secretShaped,
  deadFields,
  answeredFields,
  renderRecap,
  interviewPlan,
  profileSelftest,
} from '../lib/profile.mjs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-profile-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const TEACHING = [
  '### Module 1 — The accountable loop (id: accountable-loop)',
  'body body body',
  'Recap: loop line one.',
  '',
  '### Module 2 — memory (id: memory-layers)',
  'Recap: memory line two.',
  '### Module 3 — hooks (id: hook-points)',
  'Recap: hooks line three.',
  '### Module 4 — coordination (id: coordination)',
  'Recap: coordination line four.',
  '### Module 5 — receipts (id: receipts-vs-prose)',
  'Recap: receipts line five.',
].join('\n')

describe('readProfile — tolerant read (Test 1)', () => {
  it('missing file → {} with no warnings; corrupt JSON → {} plus a warning; valid v2 round-trips', () => {
    const missing = readProfile({ profilePath: join(dir, 'nope.json') })
    expect(missing.profile).toEqual({})
    expect(missing.warnings).toEqual([])

    const corruptPath = join(dir, 'corrupt.json')
    writeFileSync(corruptPath, '{ not: valid json', 'utf8')
    const corrupt = readProfile({ profilePath: corruptPath })
    expect(corrupt.profile).toEqual({})
    expect(corrupt.warnings.length).toBeGreaterThanOrEqual(1)

    const validPath = join(dir, 'profile.json')
    const v2 = { profileVersion: 2, pushTarget: 'github.com/acme/shop', database: 'postgres' }
    writeFileSync(validPath, JSON.stringify(v2), 'utf8')
    const ok = readProfile({ profilePath: validPath })
    expect(ok.profile).toEqual(v2)
    expect(ok.warnings).toEqual([])
  })
})

describe('normalizeProfile — pure v1→v2 upgrade (Test 2)', () => {
  it('adds profileVersion:2 in memory without mutating the input or rewriting the file', () => {
    const v1Path = join(dir, 'profile.json')
    const v1 = { pushTarget: 'github.com/acme/shop', database: 'sqlite' }
    const bytes = JSON.stringify(v1)
    writeFileSync(v1Path, bytes, 'utf8')

    const raw = readProfile({ profilePath: v1Path }).profile
    const frozen = JSON.stringify(raw)
    const upgraded = normalizeProfile(raw)

    expect(upgraded.profileVersion).toBe(2)
    expect(upgraded.pushTarget).toBe('github.com/acme/shop')
    // input object not mutated
    expect(JSON.stringify(raw)).toBe(frozen)
    expect((raw as Record<string, unknown>).profileVersion).toBeUndefined()
    // on-disk bytes untouched (readProfile never writes)
    expect(readFileSync(v1Path, 'utf8')).toBe(bytes)
  })
})

describe('validateProfile — schema (Test 3)', () => {
  it('flags an unknown top-level field and a wrong-typed field with rule PROFILE-SCHEMA', () => {
    const profile = { profileVersion: 2, riskTolerance: 7, bogusField: 'x' }
    const { ok, violations } = validateProfile(profile as never)
    expect(ok).toBe(false)
    const schemaViol = violations.filter((v) => v.rule === 'PROFILE-SCHEMA')
    expect(schemaViol.some((v) => v.field === 'riskTolerance')).toBe(true)
    expect(schemaViol.some((v) => v.field === 'bogusField')).toBe(true)
  })
})

describe('validateProfile — privacy (Test 4)', () => {
  it('rejects secret-shaped VALUES anywhere but passes env-var NAMES', () => {
    expect(secretShaped('sk-abcdef1234567890ABCDEF')).toBe(true)
    expect(secretShaped('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe(true)
    expect(secretShaped('AKIAIOSFODNN7EXAMPLE')).toBe(true)
    expect(secretShaped('xK9mP2qL7wR4tZ8nB1cV6yH3jF5dG0sA4eD2fC8bN7uJ')).toBe(true)
    // a bare env-var NAME is not a secret
    expect(secretShaped('STRIPE_SECRET_KEY')).toBe(false)
    expect(secretShaped('postgres')).toBe(false)

    const leaky = { profileVersion: 2, notes: 'the key is sk-abcdef1234567890ABCDEF do not share' }
    const bad = validateProfile(leaky as never)
    expect(bad.violations.some((v) => v.rule === 'PROFILE-SECRET')).toBe(true)

    const clean = { profileVersion: 2, envVarNames: ['STRIPE_SECRET_KEY', 'DATABASE_URL'] }
    const good = validateProfile(clean as never)
    expect(good.violations.some((v) => v.rule === 'PROFILE-SECRET')).toBe(false)
  })
})

describe('deadFields — consumer registry (Test 5)', () => {
  it('returns [] on the shipped registry; a field with no consumer appears', () => {
    expect(deadFields()).toEqual([])

    // Drop one field's consumer entry in a COPY — it becomes a dead field.
    const sabotaged = { ...PROFILE_CONSUMERS }
    delete (sabotaged as Record<string, unknown>).riskTolerance
    const dead = deadFields({ schema: PROFILE_SCHEMA, consumers: sabotaged })
    expect(dead).toContain('riskTolerance')
  })
})

describe('answeredFields — coverage (Test 6)', () => {
  it('counts only fields the user actually answered', () => {
    const profile = {
      profileVersion: 2,
      pushTarget: 'github.com/acme/shop',
      database: 'postgres',
      stack: { languages: ['typescript'], frameworks: [], packageManager: 'pnpm' },
      deployHost: '',
      sharedCounters: [],
      riskTolerance: 'balanced',
    }
    const answered = answeredFields(profile as never)
    // pushTarget, database, stack, riskTolerance = 4 answered.
    // profileVersion is meta (not counted); deployHost '' and sharedCounters []
    // are unset → not counted.
    expect(answered).toContain('pushTarget')
    expect(answered).toContain('database')
    expect(answered).toContain('stack')
    expect(answered).toContain('riskTolerance')
    expect(answered).not.toContain('profileVersion')
    expect(answered).not.toContain('deployHost')
    expect(answered).not.toContain('sharedCounters')
    expect(answered.length).toBe(4)
  })
})

describe('renderRecap — determinism (Test 7)', () => {
  it('is pure and byte-identical across calls; unset fields render as «not set»; module recaps come from teachingSource', () => {
    const profile = { profileVersion: 2, pushTarget: 'github.com/acme/shop', database: 'postgres' }
    const seededFiles = ['.planning/PROJECT.md', '.sma/profile.json']

    const a = renderRecap({ profile, teachingSource: TEACHING, seededFiles })
    const b = renderRecap({ profile, teachingSource: TEACHING, seededFiles })
    expect(a).toBe(b)

    // the five module recap lines are read from the injected teachingSource
    expect(a).toContain('loop line one.')
    expect(a).toContain('receipts line five.')
    // an unanswered field renders the honest not-set copy
    expect(a).toContain('not set — will ask when needed')
    // no wall-clock leakage
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    // seeded files listed
    expect(a).toContain('.planning/PROJECT.md')
  })
})

// A profile answering EVERY non-meta schema field — the base for the unset-N and
// nothing-to-ask fixtures. Values are the minimal type-valid non-empty answer.
function fullyAnswered(): Record<string, unknown> {
  const p: Record<string, unknown> = { profileVersion: 2 }
  for (const e of PROFILE_SCHEMA) {
    if (e.askStage === 'meta') continue
    switch (e.type) {
      case 'number':
        p[e.field] = 1
        break
      case 'enum':
        p[e.field] = (e as { values: string[] }).values[0]
        break
      case 'string[]':
        p[e.field] = ['x']
        break
      case 'object':
        p[e.field] = { k: 'v' }
        break
      default:
        p[e.field] = 'x'
    }
  }
  return p
}

describe('interviewPlan — deterministic unset-fields planner (Tests 1-5)', () => {
  it('Test 1: exactly the 2 unset fields, in askStage A→D then schema order, each carrying {field, askStage, description}', () => {
    const p = fullyAnswered()
    delete p.riskTolerance // stage D
    delete p.parallelTerminals // stage A
    const plan = interviewPlan(p)
    expect(plan.nothingToAsk).toBe(false)
    // A before D regardless of the deletion order above
    expect(plan.entries.map((e) => e.field)).toEqual(['parallelTerminals', 'riskTolerance'])
    expect(plan.entries[0]).toEqual({ field: 'parallelTerminals', askStage: 'A', description: expect.any(String) })
    expect(plan.entries[1].askStage).toBe('D')
  })

  it('Test 2: a fully-answered profile → [] and nothingToAsk:true (never a manufactured question)', () => {
    const plan = interviewPlan(fullyAnswered())
    expect(plan.entries).toEqual([])
    expect(plan.nothingToAsk).toBe(true)
  })

  it('Test 3: a v1 profile (no profileVersion) is normalized first — v2-only unset fields appear, v1-answered fields do not', () => {
    const v1 = { pushTarget: 'github.com/acme/shop', database: 'postgres' }
    const plan = interviewPlan(v1)
    const fields = plan.entries.map((e) => e.field)
    expect(fields).not.toContain('pushTarget') // already answered in the v1 file
    expect(fields).not.toContain('database')
    expect(fields).toContain('stack') // genuinely unset → asked
    expect(fields).not.toContain('profileVersion') // meta is never asked
  })

  it('Test 4: no profile at all → the FULL non-meta schema in askStage order (honest degradation, still zero TEACH)', () => {
    const plan = interviewPlan({})
    const nonMeta = PROFILE_SCHEMA.filter((s) => s.askStage !== 'meta')
    expect(plan.entries.length).toBe(nonMeta.length)
    expect(plan.nothingToAsk).toBe(false)
    expect(plan.entries.some((e) => e.field === 'profileVersion')).toBe(false)
    // stages are non-decreasing A→D
    const order: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 }
    const stages = plan.entries.map((e) => order[e.askStage])
    expect(stages).toEqual([...stages].sort((a, b) => a - b))
  })

  it('Test 5: determinism — two calls with identical input are deeply equal (no Date.now, no randomness)', () => {
    const p = fullyAnswered()
    delete p.notes
    delete p.envVarNames
    expect(interviewPlan(p)).toEqual(interviewPlan(p))
  })
})

describe('profileSelftest — the self-proving fixture pair (Test 6)', () => {
  it('returns 1 on the real planner; 0 when the planner is sabotaged to re-ask an answered field', () => {
    expect(profileSelftest()).toBe(1)
    // A sabotaged planner that fabricates a single (wrong) entry fails the 2-unset fixture → 0.
    const sabotaged = () => ({ entries: [{ field: 'stack', askStage: 'B', description: 'x' }], nothingToAsk: false })
    expect(profileSelftest(sabotaged as never)).toBe(0)
  })
})
