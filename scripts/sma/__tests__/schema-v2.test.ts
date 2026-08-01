/**
 * Tests for scripts/sma/lib/schema-v2.mjs — the memory RECORD schema vocabulary.
 *
 * schema-v2.mjs is the single place where Memory Model 1.0 (docs/MEMORY-MODEL.md)
 * becomes code: the closed enums, the id law, the private-facet rule, the
 * FACT/INTERPRETATION disciplines, the composite fingerprint shape and the
 * risk-based approval ladder. It is UNRELATED to evidence.mjs (burden-of-proof
 * records for risky ops), fingerprint.mjs (terminal coordination) and claims.mjs
 * (slot gate) — same words, different subjects.
 *
 * Every fixture below is synthetic: an invented web-shop, invented ids, invented
 * refs. No corpus text, no real paths, no personal data.
 */

import { describe, it, expect } from 'vitest'

import { readFileSync } from 'node:fs'

import { fileURLToPath } from 'node:url'

import {
  MEMORY_TYPES,
  TRUTH_MODES,
  SENSITIVITY_CLASSES,
  AUTHORITY_LEVELS,
  STATUS_VALUES,
  RISK_LEVELS,
  CONTEXT_PRIORITIES,
  PRIVATE_FACET_PATTERN,
  isPrivateFacet,
  validateId,
  validateRecord,
  resolveApprovalPath,
  APPROVAL_PATHS,
  GRACE_HORIZON,
} from '../lib/schema-v2.mjs'

// ── Enum registries: exact membership + freeze ───────────────────────────────

describe('schema-v2 enum registries', () => {
  it('MEMORY_TYPES carries the canon §2 types in order', () => {
    expect([...MEMORY_TYPES]).toEqual([
      'working',
      'semantic',
      'episodic',
      'procedural',
      'prospective',
      'normative',
      'preference',
    ])
  })

  it('TRUTH_MODES carries the canon §3 modes in order', () => {
    expect([...TRUTH_MODES]).toEqual([
      'observed',
      'inferred',
      'factual',
      'hypothesis',
      'decision',
      'normative',
    ])
  })

  it('SENSITIVITY_CLASSES is exactly public/internal/sensitive/encrypted-required', () => {
    expect([...SENSITIVITY_CLASSES]).toEqual([
      'public',
      'internal',
      'sensitive',
      'encrypted-required',
    ])
  })

  it('AUTHORITY_LEVELS is exactly owner-instruction/external-review/self-observed/inferred', () => {
    expect([...AUTHORITY_LEVELS]).toEqual([
      'owner-instruction',
      'external-review',
      'self-observed',
      'inferred',
    ])
  })

  it('STATUS_VALUES carries the lifecycle states, including the draft state the discipline needs', () => {
    expect([...STATUS_VALUES]).toEqual([
      'active',
      'superseded',
      'revoked',
      'expired',
      'archived',
      'draft',
    ])
  })

  it('RISK_LEVELS and CONTEXT_PRIORITIES carry their locked values', () => {
    expect([...RISK_LEVELS]).toEqual(['low', 'medium', 'high', 'critical'])
    expect([...CONTEXT_PRIORITIES]).toEqual(['always', 'on-demand'])
  })

  it('every enum export is frozen (a closed vocabulary cannot be widened at runtime)', () => {
    for (const registry of [
      MEMORY_TYPES,
      TRUTH_MODES,
      SENSITIVITY_CLASSES,
      AUTHORITY_LEVELS,
      STATUS_VALUES,
      RISK_LEVELS,
      CONTEXT_PRIORITIES,
    ]) {
      expect(Object.isFrozen(registry)).toBe(true)
      expect(() => (registry as string[]).push('smuggled')).toThrow()
    }
  })
})

// ── The id law: id === filename stem ─────────────────────────────────────────

describe('validateId', () => {
  it('accepts an id equal to the filename stem', () => {
    expect(validateId('mem-checkout-retry-001', 'notes/mem-checkout-retry-001.md')).toBeNull()
  })

  it('applies the same law to episode files under episodes/', () => {
    expect(validateId('ep-2026-03-12-double-charge', 'episodes/ep-2026-03-12-double-charge.md')).toBeNull()
  })

  it('rejects a mismatch with a message naming both the id and the stem', () => {
    const error = validateId('mem-checkout-retry-001', 'notes/mem-checkout-retry-002.md')
    expect(error).toBeTypeOf('string')
    expect(error).toContain('mem-checkout-retry-001')
    expect(error).toContain('mem-checkout-retry-002')
  })

  it('rejects a missing or non-string id', () => {
    expect(validateId(undefined, 'notes/mem-a.md')).toBeTypeOf('string')
    expect(validateId('', 'notes/mem-a.md')).toBeTypeOf('string')
  })

  it('handles both path separators', () => {
    expect(validateId('mem-a', 'notes\\mem-a.md')).toBeNull()
    expect(validateId('mem-a', 'notes/mem-a.md')).toBeNull()
  })
})

// ── Private facets: the installation-private `phase:NN` grain ────────────────

describe('private facets', () => {
  it('PRIVATE_FACET_PATTERN is a non-global RegExp (no lastIndex statefulness)', () => {
    expect(PRIVATE_FACET_PATTERN).toBeInstanceOf(RegExp)
    expect(PRIVATE_FACET_PATTERN.global).toBe(false)
  })

  it('flags phase-numbered values wherever they appear (applies_to and retrieval areas)', () => {
    const appliesTo = ['checkout-service', 'phase:8']
    const areas = ['payments', 'phase:49.5']
    expect(appliesTo.filter(isPrivateFacet)).toEqual(['phase:8'])
    expect(areas.filter(isPrivateFacet)).toEqual(['phase:49.5'])
  })

  it('passes ordinary areas and non-numeric phase-ish words', () => {
    for (const value of ['checkout', 'payments', 'release', 'phase', 'phase:onboarding', 'phases:8']) {
      expect(isPrivateFacet(value)).toBe(false)
    }
  })

  it('is tolerant of non-string input', () => {
    expect(isPrivateFacet(undefined)).toBe(false)
    expect(isPrivateFacet(null)).toBe(false)
    expect(isPrivateFacet(42)).toBe(false)
  })
})

// ── validateRecord ───────────────────────────────────────────────────────────
//
// Synthetic fixtures only: an invented web-shop, invented ids, invented refs.

/** A FACT record that carries its check — the shape the FACT discipline demands. */
const factRecord = () => ({
  id: 'mem-shop-pricing-version-001',
  schema_version: 2,
  status: 'active',
  memory_type: 'semantic',
  truth_mode: 'factual',
  claim: 'The shop pricing engine ships at version 3.2.0.',
  language: 'en',
  sensitivity: 'internal',
  verification: {
    command: 'shop-cli pricing --version',
    expected: '3.2.0',
  },
})

/** An INTERPRETATION record that carries its provenance — the R4 shape. */
const ruleRecord = () => ({
  id: 'mem-shop-release-gate-001',
  schema_version: 2,
  status: 'active',
  memory_type: 'normative',
  truth_mode: 'normative',
  claim: 'No release ships while the checkout smoke suite is red.',
  language: 'en',
  sensitivity: 'internal',
  source: {
    authority: 'owner-instruction',
    refs: ['instruction:shop-release-gate'],
  },
  evidence: [{ type: 'episode', ref: 'episode:shop-checkout-rollback' }],
})

describe('validateRecord — the well-formed records', () => {
  it('accepts a FACT record carrying its verification', () => {
    expect(validateRecord(factRecord())).toEqual({ errors: [], warnings: [] })
  })

  it('accepts an INTERPRETATION record carrying authority and evidence', () => {
    expect(validateRecord(ruleRecord())).toEqual({ errors: [], warnings: [] })
  })
})

describe('validateRecord — required fields and the one-claim law', () => {
  const required = [
    'id',
    'schema_version',
    'status',
    'memory_type',
    'truth_mode',
    'claim',
    'language',
    'sensitivity',
  ]

  for (const field of required) {
    it(`errors when ${field} is missing`, () => {
      const record = factRecord()
      delete (record as Record<string, unknown>)[field]
      const { errors } = validateRecord(record)
      expect(errors.some((e) => e.startsWith(`${field}:`))).toBe(true)
    })
  }

  it('errors when claim is an array — one durable claim per record', () => {
    const record = { ...factRecord(), claim: ['first claim', 'second claim'] }
    const { errors } = validateRecord(record)
    expect(errors.some((e) => e.startsWith('claim:'))).toBe(true)
  })

  it('errors when claim is an empty string', () => {
    const { errors } = validateRecord({ ...factRecord(), claim: '   ' })
    expect(errors.some((e) => e.startsWith('claim:'))).toBe(true)
  })

  it('errors on a schema_version other than 2', () => {
    const { errors } = validateRecord({ ...factRecord(), schema_version: 1 })
    expect(errors.some((e) => e.startsWith('schema_version:'))).toBe(true)
  })

  it('errors on values outside the closed vocabularies, naming the field', () => {
    const record = {
      ...factRecord(),
      memory_type: 'anecdotal',
      truth_mode: 'vibes',
      status: 'pending',
      sensitivity: 'top-secret',
      risk: 'apocalyptic',
      context_priority: 'sometimes',
      source: { authority: 'the-vibe', refs: ['note:x'] },
    }
    const { errors } = validateRecord(record)
    for (const field of [
      'memory_type',
      'truth_mode',
      'status',
      'sensitivity',
      'risk',
      'context_priority',
      'source.authority',
    ]) {
      expect(errors.some((e) => e.startsWith(`${field}:`))).toBe(true)
    }
  })

  it('warns (never errors) on a top-level key outside the schema field universe', () => {
    const { errors, warnings } = validateRecord({ ...factRecord(), episode_of: 'episode:shop-x' })
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.includes('episode_of'))).toBe(true)
  })

  it('errors on a null or non-object record', () => {
    expect(validateRecord(null).errors.length).toBeGreaterThan(0)
    expect(validateRecord('not a record').errors.length).toBeGreaterThan(0)
  })
})

describe('validateRecord — the FACT discipline', () => {
  it('errors when a factual claim carries neither verification nor fingerprint', () => {
    const record = factRecord()
    delete (record as Record<string, unknown>).verification
    const { errors } = validateRecord(record)
    expect(errors.some((e) => e.startsWith('truth_mode:') && e.includes('verification'))).toBe(true)
  })

  it('accepts a factual claim carrying a fingerprint instead of a verification block', () => {
    const record = factRecord()
    delete (record as Record<string, unknown>).verification
    const withFingerprint = {
      ...record,
      fingerprint: { product_version: '3.2.0', tree_paths: ['src/pricing/**'], tree_hash: '9f2c41d7' },
    }
    expect(validateRecord(withFingerprint)).toEqual({ errors: [], warnings: [] })
  })

  it('applies the same rule to observed claims', () => {
    const record = { ...factRecord(), truth_mode: 'observed' }
    delete (record as Record<string, unknown>).verification
    expect(validateRecord(record).errors.some((e) => e.startsWith('truth_mode:'))).toBe(true)
  })

  it('degrades the finding to a warning for a record migrated from v1 (option signal)', () => {
    const record = factRecord()
    delete (record as Record<string, unknown>).verification
    const { errors, warnings } = validateRecord(record, { migratedFromV1: true })
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.startsWith('truth_mode:'))).toBe(true)
  })

  it('degrades the finding to a warning when the record declares its own v1 provenance', () => {
    const record = { ...factRecord(), migrated_from: 'v1' }
    delete (record as Record<string, unknown>).verification
    const { errors, warnings } = validateRecord(record)
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.startsWith('truth_mode:'))).toBe(true)
  })
})

describe('validateRecord — the INTERPRETATION discipline', () => {
  it('errors when an interpretation carries no source authority', () => {
    const record = ruleRecord()
    delete (record as Record<string, unknown>).source
    const { errors } = validateRecord(record)
    expect(errors.some((e) => e.startsWith('source.authority:'))).toBe(true)
  })

  it('errors when an ACTIVE interpretation carries no evidence', () => {
    const record = ruleRecord()
    delete (record as Record<string, unknown>).evidence
    const { errors } = validateRecord(record)
    expect(errors.some((e) => e.startsWith('evidence:'))).toBe(true)
  })

  it('treats the honest none-recorded value as no evidence', () => {
    const { errors } = validateRecord({ ...ruleRecord(), evidence: 'none-recorded' })
    expect(errors.some((e) => e.startsWith('evidence:'))).toBe(true)
  })

  it('lets a draft interpretation stand without evidence — draft is where it belongs', () => {
    const record = { ...ruleRecord(), status: 'draft' }
    delete (record as Record<string, unknown>).evidence
    expect(validateRecord(record).errors).toEqual([])
  })

  it('covers inferred, hypothesis and decision modes with the same rule', () => {
    for (const truth_mode of ['inferred', 'hypothesis', 'decision']) {
      const record = { ...ruleRecord(), memory_type: 'episodic', truth_mode }
      delete (record as Record<string, unknown>).source
      expect(validateRecord(record).errors.some((e) => e.startsWith('source.authority:'))).toBe(true)
    }
  })

  it('degrades both findings to warnings for a migrated record', () => {
    const record = ruleRecord()
    delete (record as Record<string, unknown>).source
    delete (record as Record<string, unknown>).evidence
    const { errors, warnings } = validateRecord(record, { migratedFromV1: true })
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.startsWith('source.authority:'))).toBe(true)
    expect(warnings.some((w) => w.startsWith('evidence:'))).toBe(true)
  })
})

describe('validateRecord — the composite fingerprint shape', () => {
  it('errors when a fingerprint carries no product version', () => {
    const record = { ...factRecord(), fingerprint: { tree_paths: ['src/pricing/**'] } }
    expect(validateRecord(record).errors.some((e) => e.startsWith('fingerprint.product_version:'))).toBe(true)
  })

  it('errors when a tree hash arrives without the paths it hashes', () => {
    const record = { ...factRecord(), fingerprint: { product_version: '3.2.0', tree_hash: '9f2c41d7' } }
    expect(validateRecord(record).errors.some((e) => e.startsWith('fingerprint.tree_hash:'))).toBe(true)
  })

  it('errors when tree_paths is not an array of strings', () => {
    const record = { ...factRecord(), fingerprint: { product_version: '3.2.0', tree_paths: 'src/pricing/**' } }
    expect(validateRecord(record).errors.some((e) => e.startsWith('fingerprint.tree_paths:'))).toBe(true)
  })

  it('accepts the product-version-only fingerprint (the external-artifact epoch stamp)', () => {
    const record = { ...factRecord(), fingerprint: { product_version: '3.2.0' } }
    expect(validateRecord(record)).toEqual({ errors: [], warnings: [] })
  })
})

describe('validateRecord — external-artifact freshness', () => {
  it('errors when an evidence ref points at a URL and no valid_until is set', () => {
    const record = {
      ...factRecord(),
      evidence: [{ type: 'artifact', ref: 'https://example.invalid/shop/pricing-map' }],
    }
    expect(validateRecord(record).errors.some((e) => e.startsWith('valid_until:'))).toBe(true)
  })

  it('errors on the same shape when the URL sits in source.refs', () => {
    const record = {
      ...ruleRecord(),
      source: { authority: 'external-review', refs: ['https://example.invalid/shop/review'] },
    }
    expect(validateRecord(record).errors.some((e) => e.startsWith('valid_until:'))).toBe(true)
  })

  it('accepts the URL claim once it carries a validity horizon', () => {
    const record = {
      ...factRecord(),
      valid_until: '2026-12-31',
      evidence: [{ type: 'artifact', ref: 'https://example.invalid/shop/pricing-map' }],
    }
    expect(validateRecord(record)).toEqual({ errors: [], warnings: [] })
  })

  it('leaves non-URL refs alone', () => {
    const record = { ...factRecord(), evidence: [{ type: 'test', ref: 'test:shop-pricing-version' }] }
    expect(validateRecord(record)).toEqual({ errors: [], warnings: [] })
  })
})

describe('validateRecord — the three failure classes the v1 corpus actually shows', () => {
  it('(a) stale-fact class: a version claim with no way to re-check it', () => {
    const record = {
      id: 'mem-shop-current-release-001',
      schema_version: 2,
      status: 'active',
      memory_type: 'semantic',
      truth_mode: 'factual',
      claim: 'The current shop release is 3.2.0.',
      language: 'en',
      sensitivity: 'internal',
    }
    const { errors } = validateRecord(record)
    expect(errors.some((e) => e.startsWith('truth_mode:') && e.includes('verification'))).toBe(true)
    const migrated = validateRecord(record, { migratedFromV1: true })
    expect(migrated.errors).toEqual([])
    expect(migrated.warnings.length).toBeGreaterThan(0)
  })

  it('(b) expired-waiver class: a past valid_until is a lint finding, not a schema error', () => {
    const record = {
      ...factRecord(),
      valid_from: '2026-01-01',
      valid_until: '2026-01-31',
    }
    expect(validateRecord(record)).toEqual({ errors: [], warnings: [] })
  })

  it('(c) provenance-contraband class: an owner instruction with no evidence behind it', () => {
    const record = {
      id: 'mem-shop-doc-rule-001',
      schema_version: 2,
      status: 'active',
      memory_type: 'normative',
      truth_mode: 'normative',
      claim: 'Every shipped change updates the shop handbook in the same commit.',
      language: 'en',
      sensitivity: 'internal',
      source: { authority: 'owner-instruction', refs: [] },
    }
    expect(validateRecord(record).errors.some((e) => e.startsWith('evidence:'))).toBe(true)
  })
})

// ── The risk-based approval ladder ───────────────────────────────────────────

describe('resolveApprovalPath — the mapped classes', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    [
      'a low-risk observation of the task in flight rides a TTL',
      { memory_type: 'working', truth_mode: 'observed', sensitivity: 'internal', risk: 'low' },
      'auto-ttl',
    ],
    [
      'a candidate lesson from an episode lands as a draft',
      { memory_type: 'episodic', truth_mode: 'hypothesis', sensitivity: 'internal', risk: 'low' },
      'auto-draft',
    ],
    [
      'an inferred procedural candidate is still a draft',
      { memory_type: 'procedural', truth_mode: 'inferred', sensitivity: 'internal', risk: 'medium' },
      'auto-draft',
    ],
    [
      'a settled procedural recommendation needs an evidence threshold',
      { memory_type: 'procedural', truth_mode: 'factual', sensitivity: 'internal', risk: 'medium' },
      'evidence-review',
    ],
    [
      'a reflex-grade rule needs a human',
      { memory_type: 'normative', truth_mode: 'normative', sensitivity: 'internal', risk: 'high' },
      'human-approval',
    ],
    [
      'an owner preference is a versioned, owner-controlled record',
      { memory_type: 'preference', truth_mode: 'decision', sensitivity: 'internal', risk: 'low' },
      'owner-versioned',
    ],
    [
      'a decision policy is versioned and replayable',
      { memory_type: 'semantic', truth_mode: 'decision', sensitivity: 'internal', risk: 'medium' },
      'versioned-replay',
    ],
    [
      'a sensitive record is governed, human-only',
      { memory_type: 'semantic', truth_mode: 'factual', sensitivity: 'sensitive', risk: 'low' },
      'governed-human-only',
    ],
  ]

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(resolveApprovalPath(input)).toBe(expected)
    })
  }

  it('produces every one of the seven paths across the table', () => {
    const produced = new Set(cases.map(([, input]) => resolveApprovalPath(input)))
    expect([...APPROVAL_PATHS].every((path) => produced.has(path))).toBe(true)
    expect(APPROVAL_PATHS).toHaveLength(7)
    expect(Object.isFrozen(APPROVAL_PATHS)).toBe(true)
  })
})

describe('resolveApprovalPath — escalation and the safe default', () => {
  it('escalates encrypted-required to governed-human-only whatever else the record says', () => {
    for (const memory_type of MEMORY_TYPES) {
      for (const risk of RISK_LEVELS) {
        expect(
          resolveApprovalPath({
            memory_type,
            truth_mode: 'observed',
            sensitivity: 'encrypted-required',
            risk,
          }),
        ).toBe('governed-human-only')
      }
    }
  })

  it('escalates critical risk to governed-human-only', () => {
    expect(
      resolveApprovalPath({
        memory_type: 'working',
        truth_mode: 'observed',
        sensitivity: 'public',
        risk: 'critical',
      }),
    ).toBe('governed-human-only')
  })

  it('falls closed on missing input — never a permissive default', () => {
    expect(resolveApprovalPath({})).toBe('governed-human-only')
    expect(resolveApprovalPath()).toBe('governed-human-only')
    expect(resolveApprovalPath(null)).toBe('governed-human-only')
    expect(
      resolveApprovalPath({ memory_type: 'working', truth_mode: 'observed', sensitivity: 'internal' }),
    ).toBe('governed-human-only')
  })

  it('falls closed on values outside the closed vocabularies', () => {
    expect(
      resolveApprovalPath({
        memory_type: 'anecdotal',
        truth_mode: 'observed',
        sensitivity: 'internal',
        risk: 'low',
      }),
    ).toBe('governed-human-only')
    expect(
      resolveApprovalPath({
        memory_type: 'working',
        truth_mode: 'observed',
        sensitivity: 'internal',
        risk: 'apocalyptic',
      }),
    ).toBe('governed-human-only')
  })

  it('never returns an automatic path for a well-formed record it has no rule for', () => {
    const path = resolveApprovalPath({
      memory_type: 'prospective',
      truth_mode: 'factual',
      sensitivity: 'internal',
      risk: 'medium',
    })
    expect(APPROVAL_PATHS).toContain(path)
    expect(['auto-ttl', 'auto-draft']).not.toContain(path)
  })

  it('is deterministic — same input, same path', () => {
    const input = { memory_type: 'procedural', truth_mode: 'factual', sensitivity: 'internal', risk: 'medium' }
    expect(resolveApprovalPath(input)).toBe(resolveApprovalPath({ ...input }))
  })
})

describe('GRACE_HORIZON', () => {
  it('names the deadline migrated records have to grow their missing fields', () => {
    expect(GRACE_HORIZON).toBe('measurement-cycle-close')
  })
})

describe('validateRecord — purity', () => {
  it('reads no files and no clock (expiry belongs to the lint, not the schema)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../lib/schema-v2.mjs', import.meta.url)),
      'utf8',
    )
    const code = source.replace(/^\s*\*.*$/gm, '') // strip doc-comment prose
    for (const forbidden of ['readFileSync', 'writeFileSync', 'Date.now(', 'new Date(', 'process.env']) {
      expect(code).not.toContain(forbidden)
    }
  })
})
