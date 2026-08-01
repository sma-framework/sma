/**
 * Tests for the schema-v2 grammar in scripts/sma/lib/frontmatter.mjs.
 *
 * frontmatter.mjs is the single shared read/write path for every memory note.
 * Schema v2 (docs/MEMORY-MODEL.md) adds nested blocks (scope, source,
 * fingerprint, retrieval, verification) and arrays-of-objects (evidence[],
 * links[]) on top of the v1 flat/`metadata:` grammar. The parser stays
 * GRAMMAR-ONLY: it decides SHAPE, never enum/field legality (that is
 * schema-v2.mjs's job) — and it throws LOUDLY on any shape it does not know,
 * so a migration can never silently corrupt a note (B12).
 *
 * Fixtures are anchored on docs/MEMORY-MODEL.md's worked examples:
 *   - Fixture A  — full v2 record (every V2_KEY_ORDER key that carries a value);
 *                  parse -> serialize is byte-identical.
 *   - Fixture A2 — the doc's § 12.2 worked example VERBATIM (its own sub-key
 *                  spelling: fingerprint.paths/taken_at, links[].type/ref,
 *                  retrieval.semantic_index) — proves the canon document's own
 *                  record is readable, and pins the one normalization: an empty
 *                  `valid_until:` parses to null and is omitted on emit.
 *   - Fixture B  — minimal v2 record; omitted optional keys stay omitted.
 *   - Fixture C  — v1 regression: schemaVersion 1, unchanged object shape, and
 *                  byte-identical serialization (the data-loss guard).
 *   - Fixture D  — schema_version other than 2 -> loud throw naming the file.
 *   - Fixture E  — unsupported v2 nesting -> loud throw, never a guess.
 */

import { describe, it, expect } from 'vitest'

import { parseNote, serializeNote, V2_KEY_ORDER } from '../lib/frontmatter.mjs'

// ── Fixture A: a full v2 record in V2_KEY_ORDER (the round-trip law) ──────────

const V2_FULL = `---
id: mem-checkout-retry-001
schema_version: 2
status: active
memory_type: procedural
truth_mode: normative
claim: Every payment retry must send the idempotency key of the original attempt.
language: en
scope:
  repos: [web-shop]
  paths: [src/checkout/**, src/payments/**]
  environments: [production, staging]
applies_to: [checkout-service, payment-client]
source:
  authority: verified-incident
  refs: [incident:2026-03-12-double-charge, receipt:R-118]
evidence:
  - type: test
    ref: test:checkout-retry-idempotency
  - type: incident
    ref: incident:2026-03-12-double-charge
fingerprint:
  product_version: 5.0.4
  tree_paths: [src/checkout/retry.ts, src/payments/client.ts]
  tree_hash: 9f2c41d7
observed_at: 2026-03-12T22:41:00Z
recorded_at: 2026-03-14T09:30:00Z
valid_from: 2026-03-14
criticality: high
frequency: medium
confidence: 0.97
freshness: 2026-03-14
context_priority: on-demand
risk: review-required
sensitivity: internal
retention: until-revoked
retrieval:
  areas: [checkout, payments]
  entities: [payment-gateway, idempotency-key]
  task_types: [bugfix, refactor, release]
  paths: [src/checkout/**, src/payments/**]
verification:
  command: npm test -- checkout-retry-idempotency
  expected: exit-code-0
links:
  - rel: derived_from
    target: episode:2026-03-12-checkout-outage
  - rel: verified_by
    target: test:checkout-retry-idempotency
derived_from: episode:2026-03-12-checkout-outage
---
The 2026-03-12 incident narrative lives in the linked episode record.
This claim carries only the durable rule and its check.
`

// ── Fixture A2: docs/MEMORY-MODEL.md § 12.2, verbatim ─────────────────────────

const V2_DOC_EXAMPLE = `---
id: mem-checkout-retry-001
schema_version: 2
status: active
memory_type: procedural
truth_mode: normative
claim: Every payment retry must send the idempotency key of the original attempt.
scope:
  repos: [web-shop]
  paths: [src/checkout/**, src/payments/**]
  environments: [production, staging]
source:
  authority: verified-incident
  refs: [incident:2026-03-12-double-charge]
evidence:
  - type: test
    ref: test:checkout-retry-idempotency
fingerprint:
  paths: [src/checkout/retry.ts, src/payments/client.ts]
  tree_hash: 9f2c41d7
  taken_at: 2026-03-14T09:30:00Z
observed_at: 2026-03-12T22:41:00Z
recorded_at: 2026-03-14T09:30:00Z
valid_from: 2026-03-14
valid_until:
criticality: high
frequency: medium
confidence: 0.97
freshness: 2026-03-14
context_priority: on-demand
risk: review-required
sensitivity: internal
retention: until-revoked
retrieval:
  areas: [checkout, payments]
  entities: [payment-gateway, idempotency-key]
  task_types: [bugfix, refactor, release]
  paths: [src/checkout/**, src/payments/**]
  semantic_index: false
verification:
  command: npm test -- checkout-retry-idempotency
  expected: exit-code-0
links:
  - type: derived_from
    ref: episode:2026-03-12-checkout-outage
  - type: verified_by
    ref: test:checkout-retry-idempotency
---
The 2026-03-12 incident narrative lives in the linked episode record.
This claim carries only the durable rule and its check.
`

/** The doc example after the ONE documented normalization: empty `valid_until:` omitted. */
const V2_DOC_EXAMPLE_EMITTED = V2_DOC_EXAMPLE.replace('valid_until:\n', '')

// ── Fixture B: the minimal legal v2 record ────────────────────────────────────

const V2_MINIMAL = `---
id: mem-shop-img-cdn-001
schema_version: 2
status: draft
memory_type: semantic
truth_mode: factual
claim: Product images are served from the img CDN subdomain.
language: en
sensitivity: internal
---
Nothing else is known about this claim yet.
`

// ── Fixture C: v1 regression (no schema_version anywhere) ─────────────────────

/** A NORMALIZED v1 note — serializeNote must return it byte-for-byte. */
const V1_NORMALIZED = `---
description: Parallel-terminal collisions are inevitable when several sessions run.
kind: feedback
tags: [governance, tooling]
use-when: another terminal touches the files you are editing
importance: 7
---
Body prose that must survive byte-for-byte.
`

/** The hook's nested shape — the parsed object must stay exactly as v1 produced it. */
const V1_NESTED = `---
name: reference_hook_nested_example
description: "A hook-nested note: block-sequence tags + nested use-when under metadata."
metadata:
  node_type: memory
  kind: reference
  tags:
    - crm
    - content
  use-when: "building the document summary; search quality work"
  importance: 7
  originSessionId: abcd1234-0000-1111-2222-333344445555
---
Body content that must survive byte-for-byte.
`

// ── Fixture D: an unknown schema_version ──────────────────────────────────────

const V3_UNKNOWN = `---
id: mem-from-the-future-001
schema_version: 3
status: active
claim: A grammar this parser has never been taught.
---
Body.
`

// ── Fixture E: unsupported v2 nesting (a block inside a block) ────────────────

const V2_DEEP_NEST = `---
id: mem-bad-shape-001
schema_version: 2
status: active
scope:
  repos:
    primary: web-shop
    mirror: web-shop-mirror
---
Body.
`

/** An unknown nested block label — the grammar cannot know how to read it. */
const V2_UNKNOWN_BLOCK = `---
id: mem-bad-block-001
schema_version: 2
status: active
provenance:
  authority: verified-incident
---
Body.
`

function fmOf(text: string): string {
  return text.slice(4, text.indexOf('\n---\n', 3) + 1)
}

describe('schema discriminator', () => {
  it('reports schemaVersion 2 for a v2 record and 1 for a v1 record', () => {
    expect(parseNote(V2_FULL, { file: 'a.md' }).schemaVersion).toBe(2)
    expect(parseNote(V2_MINIMAL, { file: 'b.md' }).schemaVersion).toBe(2)
    expect(parseNote(V1_NORMALIZED, { file: 'c.md' }).schemaVersion).toBe(1)
    expect(parseNote(V1_NESTED, { file: 'c2.md' }).schemaVersion).toBe(1)
  })

  it('Fixture D: any schema_version other than 2 throws loudly, naming the file', () => {
    let err: any
    try {
      parseNote(V3_UNKNOWN, { file: 'future.md' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('future.md')
    expect(err.message).toContain('schema_version')
    expect(err.message).toContain('3')
  })
})

describe('Fixture A: full v2 record', () => {
  it('parses every block into a structured object/array', () => {
    const { frontmatter, body } = parseNote(V2_FULL, { file: 'full.md' })

    expect(frontmatter.id).toBe('mem-checkout-retry-001')
    expect(frontmatter.schema_version).toBe('2')
    expect(frontmatter.claim).toBe(
      'Every payment retry must send the idempotency key of the original attempt.',
    )

    // Nested scalar-children blocks.
    expect(frontmatter.scope).toEqual({
      repos: ['web-shop'],
      paths: ['src/checkout/**', 'src/payments/**'],
      environments: ['production', 'staging'],
    })
    expect(frontmatter.source).toEqual({
      authority: 'verified-incident',
      refs: ['incident:2026-03-12-double-charge', 'receipt:R-118'],
    })
    expect(frontmatter.fingerprint).toEqual({
      product_version: '5.0.4',
      tree_paths: ['src/checkout/retry.ts', 'src/payments/client.ts'],
      tree_hash: '9f2c41d7',
    })
    expect(frontmatter.retrieval).toEqual({
      areas: ['checkout', 'payments'],
      entities: ['payment-gateway', 'idempotency-key'],
      task_types: ['bugfix', 'refactor', 'release'],
      paths: ['src/checkout/**', 'src/payments/**'],
    })
    expect(frontmatter.verification).toEqual({
      command: 'npm test -- checkout-retry-idempotency',
      expected: 'exit-code-0',
    })

    // Arrays of objects.
    expect(frontmatter.evidence).toEqual([
      { type: 'test', ref: 'test:checkout-retry-idempotency' },
      { type: 'incident', ref: 'incident:2026-03-12-double-charge' },
    ])
    expect(frontmatter.links).toEqual([
      { rel: 'derived_from', target: 'episode:2026-03-12-checkout-outage' },
      { rel: 'verified_by', target: 'test:checkout-retry-idempotency' },
    ])

    // Inline top-level array.
    expect(frontmatter.applies_to).toEqual(['checkout-service', 'payment-client'])

    // Body verbatim.
    expect(body).toBe(
      'The 2026-03-12 incident narrative lives in the linked episode record.\n' +
        'This claim carries only the durable rule and its check.\n',
    )
  })

  it('round-trips byte-for-byte (R3 serialization law)', () => {
    const out = serializeNote(parseNote(V2_FULL, { file: 'full.md' }))
    expect(out).toBe(V2_FULL)
  })

  it('emits top-level keys in V2_KEY_ORDER', () => {
    const emitted = fmOf(serializeNote(parseNote(V2_FULL, { file: 'full.md' })))
      .split('\n')
      .filter((l) => /^[a-zA-Z][\w-]*:/.test(l))
      .map((l) => l.slice(0, l.indexOf(':')))
    const expected = V2_KEY_ORDER.filter((k: string) => emitted.includes(k))
    expect(emitted).toEqual(expected)
    // The order constant itself is the published serialization law.
    expect(V2_KEY_ORDER[0]).toBe('id')
    expect(V2_KEY_ORDER[1]).toBe('schema_version')
  })
})

describe('Fixture A2: the MEMORY-MODEL.md worked example', () => {
  it('parses the canon document record, including its own sub-key spelling', () => {
    const { frontmatter, schemaVersion } = parseNote(V2_DOC_EXAMPLE, { file: 'doc.md' })
    expect(schemaVersion).toBe(2)
    expect(frontmatter.fingerprint).toEqual({
      paths: ['src/checkout/retry.ts', 'src/payments/client.ts'],
      tree_hash: '9f2c41d7',
      taken_at: '2026-03-14T09:30:00Z',
    })
    expect(frontmatter.retrieval.semantic_index).toBe('false')
    expect(frontmatter.links).toEqual([
      { type: 'derived_from', ref: 'episode:2026-03-12-checkout-outage' },
      { type: 'verified_by', ref: 'test:checkout-retry-idempotency' },
    ])
    // An empty scalar is null, not "" — the omit-null law then drops it on emit.
    expect(frontmatter.valid_until).toBeNull()
  })

  it('re-emits the doc example unchanged apart from the empty valid_until line', () => {
    const out = serializeNote(parseNote(V2_DOC_EXAMPLE, { file: 'doc.md' }))
    expect(out).toBe(V2_DOC_EXAMPLE_EMITTED)
    expect(out).not.toContain('valid_until:')
  })
})

describe('Fixture B: minimal v2 record', () => {
  it('round-trips byte-for-byte and omits every absent optional key', () => {
    const parsed = parseNote(V2_MINIMAL, { file: 'min.md' })
    expect(parsed.schemaVersion).toBe(2)
    const out = serializeNote(parsed)
    expect(out).toBe(V2_MINIMAL)
    for (const key of ['scope', 'source', 'evidence', 'fingerprint', 'retrieval', 'links']) {
      expect(out).not.toContain(`${key}:`)
    }
  })

  it('omits a key whose value is explicitly null', () => {
    const parsed = parseNote(V2_MINIMAL, { file: 'min.md' })
    parsed.frontmatter.valid_until = null
    parsed.frontmatter.evidence = null
    expect(serializeNote(parsed)).toBe(V2_MINIMAL)
  })
})

describe('Fixture C: v1 regression (no behavior change)', () => {
  it('serializes a normalized v1 note byte-identically', () => {
    const parsed = parseNote(V1_NORMALIZED, { file: 'v1.md' })
    expect(parsed.schemaVersion).toBe(1)
    expect(serializeNote(parsed)).toBe(V1_NORMALIZED)
  })

  it('parses the nested v1 hook shape into exactly the pre-change object', () => {
    const { frontmatter, body } = parseNote(V1_NESTED, { file: 'v1n.md' })
    expect(frontmatter).toEqual({
      name: 'reference_hook_nested_example',
      description: 'A hook-nested note: block-sequence tags + nested use-when under metadata.',
      metadata: {
        node_type: 'memory',
        kind: 'reference',
        tags: ['crm', 'content'],
        'use-when': 'building the document summary; search quality work',
        importance: '7',
        originSessionId: 'abcd1234-0000-1111-2222-333344445555',
      },
    })
    expect(body).toBe('Body content that must survive byte-for-byte.\n')
  })

  it('still returns {frontmatter: null} for a structural file, at schemaVersion 1', () => {
    const text = '# Memory Archive\n\n- [note](note.md)\n'
    const parsed = parseNote(text, { file: 'MEMORY.md' })
    expect(parsed.frontmatter).toBeNull()
    expect(parsed.body).toBe(text)
    expect(parsed.schemaVersion).toBe(1)
    expect(serializeNote(parsed)).toBe(text)
  })

  it('still refuses a v1 nested block under a key other than metadata', () => {
    const bad = '---\ndescription: x\nwhatever:\n  a: b\n---\nbody\n'
    expect(() => parseNote(bad, { file: 'v1bad.md' })).toThrow(/v1bad\.md/)
  })
})

describe('Fixture E: unsupported v2 shapes throw instead of guessing', () => {
  it('rejects a nested block inside a nested block', () => {
    let err: any
    try {
      parseNote(V2_DEEP_NEST, { file: 'deep.md' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('deep.md')
    expect(err.message).toMatch(/line \d+/)
  })

  it('rejects an unknown nested block label', () => {
    let err: any
    try {
      parseNote(V2_UNKNOWN_BLOCK, { file: 'unknown.md' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('unknown.md')
    expect(err.message).toContain('provenance')
  })

  it('rejects an array-of-objects item that is not a key: value pair', () => {
    const bad = '---\nid: x\nschema_version: 2\nevidence:\n  - just-a-string\n---\nbody\n'
    expect(() => parseNote(bad, { file: 'badev.md' })).toThrow(/badev\.md/)
  })
})
