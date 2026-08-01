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
