/**
 * Tests for the typed-link vocabulary and the link projection.
 *
 * Two subjects, one file, because they are one story: `LINK_TYPES`/`checkLinks`
 * in scripts/sma/lib/schema-v2.mjs close the edge vocabulary (docs/MEMORY-MODEL.md
 * §10), and scripts/sma/lib/links.mjs turns the records' own `links` fields into a
 * graph that is COMPUTED, never stored. The second only means anything if the
 * first refuses: a projection over an unvalidated field is a graph of whatever
 * anyone happened to type.
 *
 * NAME-COLLISION GUARD: `links` here is the machine layer of typed `{type, ref}`
 * edges between memory records. It is unrelated to the wikilinks the corpus lint
 * checks (`[[note]]` references inside note BODIES) and unrelated to the
 * `key_links` field of a plan's must-haves block.
 *
 * Every fixture below is synthetic: an invented web-shop, invented ids, invented
 * refs. No corpus text, no real paths, no personal data.
 */

import { describe, it, expect } from 'vitest'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LINK_TYPES, checkLinks, validateRecord } from '../lib/schema-v2.mjs'

/** The eleven edge names docs/MEMORY-MODEL.md §10 documents, in the doc's order. */
const CANON_SECTION_10 = [
  'derived_from',
  'supports',
  'contradicts',
  'supersedes',
  'caused_by',
  'applies_to',
  'exception_to',
  'requires',
  'verified_by',
  'owned_by',
  'part_of',
]

/**
 * A minimal legal schema-v2 record. `truth_mode: factual` is machine-rederivable,
 * so it carries a fingerprint — otherwise the discipline check would add a finding
 * of its own and muddy the assertions about `links`.
 */
function baseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'checkout-latency-budget',
    schema_version: 2,
    status: 'active',
    memory_type: 'semantic',
    truth_mode: 'factual',
    claim: 'The checkout page answers within 400 ms at p95.',
    language: 'en',
    sensitivity: 'internal',
    fingerprint: { product_version: 'shop-3.2.0' },
    ...overrides,
  }
}

// ── The closed vocabulary ────────────────────────────────────────────────────

describe('LINK_TYPES — the closed edge vocabulary (canon §10)', () => {
  it('carries exactly the eleven names docs/MEMORY-MODEL.md §10 documents', () => {
    expect([...LINK_TYPES]).toEqual(CANON_SECTION_10)
  })

  it('is frozen — widening the vocabulary is a schema decision, not a runtime one', () => {
    expect(Object.isFrozen(LINK_TYPES)).toBe(true)
  })
})

// ── checkLinks: the fail-closed validator ────────────────────────────────────

describe('checkLinks — an unknown edge type is refused, not persisted', () => {
  it('accepts every one of the eleven documented types', () => {
    for (const type of CANON_SECTION_10) {
      const record = baseRecord({ links: [{ type, ref: 'cart-abandon-rate' }] })
      expect(checkLinks(record), `type "${type}" must validate clean`).toEqual([])
    }
  })

  it('accepts the two edges the tooling itself writes today', () => {
    // The supersession pair is written by applyLifecycle as TOP-LEVEL fields, and
    // `derived_from` by episodes.mjs the same way; as edge NAMES they must both be
    // legal here, or a record that spells its own history out in `links` is refused.
    expect(checkLinks(baseRecord({ links: [{ type: 'supersedes', ref: 'checkout-latency-v1' }] }))).toEqual([])
    expect(checkLinks(baseRecord({ links: [{ type: 'derived_from', ref: 'ep-2026-03-11-checkout' }] }))).toEqual([])
  })

  it('refuses a type outside the vocabulary, naming the offending value and the field', () => {
    const findings = checkLinks(baseRecord({ links: [{ type: 'inspired_by', ref: 'cart-abandon-rate' }] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('inspired_by')
    expect(findings[0]).toContain('links')
  })

  it('refuses an entry whose ref is missing', () => {
    const findings = checkLinks(baseRecord({ links: [{ type: 'supports' }] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('ref')
    expect(findings[0]).toContain('links')
  })

  it('refuses an entry whose ref is not a string', () => {
    const findings = checkLinks(baseRecord({ links: [{ type: 'supports', ref: 42 }] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('ref')
  })

  it('refuses an entry that is not a {type, ref} object at all', () => {
    const findings = checkLinks(baseRecord({ links: ['supports:cart-abandon-rate'] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('links')
  })

  it('refuses a links field that is not an array', () => {
    const findings = checkLinks(baseRecord({ links: { type: 'supports', ref: 'cart-abandon-rate' } }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('links')
  })

  it('reports every bad entry, not just the first', () => {
    const findings = checkLinks(
      baseRecord({
        links: [
          { type: 'supports', ref: 'cart-abandon-rate' },
          { type: 'inspired_by', ref: 'cart-abandon-rate' },
          { type: 'contradicts' },
        ],
      }),
    )
    expect(findings).toHaveLength(2)
  })

  it('accepts a record with no links field — absence is legal, malformation is not', () => {
    expect(checkLinks(baseRecord())).toEqual([])
    expect(checkLinks(baseRecord({ links: [] }))).toEqual([])
  })

  it('is pure: it does not mutate the record it judges', () => {
    const record = baseRecord({ links: [{ type: 'inspired_by', ref: 'x' }] })
    const before = JSON.stringify(record)
    checkLinks(record)
    expect(JSON.stringify(record)).toBe(before)
  })
})

// ── The wiring: a validator nobody calls is not a validator ──────────────────

describe('checkLinks is wired into validateRecord', () => {
  it('surfaces an unknown edge type as a structure ERROR of the record validator', () => {
    const { errors } = validateRecord(baseRecord({ links: [{ type: 'inspired_by', ref: 'cart-abandon-rate' }] }))
    expect(errors.some((e) => e.includes('links') && e.includes('inspired_by'))).toBe(true)
  })

  it('surfaces a malformed entry missing ref as a structure ERROR', () => {
    const { errors } = validateRecord(baseRecord({ links: [{ type: 'supports' }] }))
    expect(errors.some((e) => e.includes('links') && e.includes('ref'))).toBe(true)
  })

  it('leaves a record whose links are all legal clean', () => {
    const { errors } = validateRecord(
      baseRecord({
        links: [
          { type: 'supersedes', ref: 'checkout-latency-v1' },
          { type: 'verified_by', ref: 'shop-load-test-2026-03' },
        ],
      }),
    )
    expect(errors).toEqual([])
  })

  it('leaves a record with no links field clean', () => {
    expect(validateRecord(baseRecord()).errors).toEqual([])
  })
})

// ── Source-shape guard (acceptance criterion of plan 11-02 Task 1) ───────────

describe('schema-v2.mjs source shape', () => {
  it('freezes LINK_TYPES at its declaration', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const source = readFileSync(join(here, '..', 'lib', 'schema-v2.mjs'), 'utf8')
    const lines = source.split('\n')
    const at = lines.findIndex((l) => l.includes('export const LINK_TYPES'))
    expect(at).toBeGreaterThan(-1)
    expect(`${lines[at]}\n${lines[at + 1] ?? ''}`).toContain('Object.freeze')
  })
})
