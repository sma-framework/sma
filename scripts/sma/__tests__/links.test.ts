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
 * A third block asserts the CONSUMPTION MAP (§10.2): for each of the eleven names,
 * either a reader is named, or the name stands in the doc's record of types that
 * are validated and deliberately not consumed. It reddens on three distinct edits —
 * a name added to or removed from the vocabulary without moving between the two
 * lists here, a name quietly dropped from the doc record, and the revisit condition
 * being replaced by a promise. Validation is not consumption, and a closed enum with
 * no reader looks from the outside exactly like a feature that runs.
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

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LINK_TYPES, checkLinks, validateRecord } from '../lib/schema-v2.mjs'
import { LINK_PROJECTION_VERSION, linkGraphFromCorpus, projectLinks } from '../lib/links.mjs'

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

  it('holds eleven names and no twelfth', () => {
    // The count is asserted apart from the composition on purpose: an edit that
    // appends a name AND updates the list above would keep the equality green,
    // and the number is the thing the doc, the record and this suite all quote.
    expect(LINK_TYPES).toHaveLength(11)
    expect(CANON_SECTION_10).toHaveLength(11)
  })

  it('is frozen — widening the vocabulary is a schema decision, not a runtime one', () => {
    expect(Object.isFrozen(LINK_TYPES)).toBe(true)
  })
})

// ── The consumption map: validated is not the same as consumed ───────────────

/**
 * The names whose readers live OUTSIDE this vocabulary — as top-level pointer
 * fields, or as a model of their own — written out by hand as a second yardstick.
 * Moving a name between these two lists must be a deliberate edit here, and the
 * doc record has to move with it, or the assertions below refuse.
 */
const CONSUMED_ELSEWHERE = ['derived_from', 'contradicts', 'supersedes']

/** The names that are validated fail-closed and read by no query at all. */
const DELIBERATELY_NOT_CONSUMED = [
  'supports',
  'caused_by',
  'applies_to',
  'exception_to',
  'requires',
  'verified_by',
  'owned_by',
  'part_of',
]

/**
 * docs/MEMORY-MODEL.md as shipped, read from the tree rather than paraphrased.
 * Line endings are normalized because the doc is checked out with the platform's
 * own — a paragraph boundary that only matches on LF would make these assertions
 * a statement about the checkout rather than about the document.
 */
function memoryModelDoc(): string {
  const text = readFileSync(fileURLToPath(new URL('../../../docs/MEMORY-MODEL.md', import.meta.url)), 'utf8')
  return text.replace(/\r\n/g, '\n')
}

describe('every name in the vocabulary has a stated fate (canon §10.2)', () => {
  it('the two lists together are exactly the vocabulary — no name lost, none counted twice', () => {
    const union = [...CONSUMED_ELSEWHERE, ...DELIBERATELY_NOT_CONSUMED]
    expect(union).toHaveLength(LINK_TYPES.length)
    expect(new Set(union).size).toBe(union.length)
    expect([...union].sort()).toEqual([...LINK_TYPES].sort())
  })

  it('names every deliberately-unconsumed type in the doc record, so the record cannot vanish quietly', () => {
    const doc = memoryModelDoc()
    expect(doc).toContain('deliberately not consumed')
    for (const type of DELIBERATELY_NOT_CONSUMED) {
      expect(doc, `the record must name "${type}"`).toContain(type)
    }
  })

  it('lists in that record exactly the unconsumed names — a silent reclassification is refused', () => {
    // The union assertion above cannot see a name MOVED from one list to the
    // other: the union stays the same. This one can, because the doc's own
    // sentence has to move with it.
    const doc = memoryModelDoc()
    const at = doc.indexOf('**The remaining eight')
    expect(at, 'the record paragraph must exist in docs/MEMORY-MODEL.md §10.2').toBeGreaterThan(-1)
    const end = doc.indexOf('\n\n', at)
    const paragraph = doc.slice(at, end === -1 ? undefined : end)

    for (const type of DELIBERATELY_NOT_CONSUMED) {
      expect(paragraph, `the record sentence must name "${type}"`).toContain(type)
    }
    for (const type of CONSUMED_ELSEWHERE) {
      expect(paragraph, `"${type}" has a named reader — it does not belong in this record`).not.toContain(type)
    }
  })

  it('states the condition that would give an unconsumed type a reader', () => {
    // "Deferred" is not a decision. The record carries a checkable condition, and
    // this assertion is what keeps it from decaying into an apology.
    expect(memoryModelDoc()).toContain('a type gets a reader together with the first query that needs it')
  })

  it('names, for each consumed type, that its reader is not the edge itself', () => {
    const doc = memoryModelDoc()
    for (const type of CONSUMED_ELSEWHERE) {
      expect(doc, `the map must name "${type}"`).toContain(type)
    }
    expect(doc).toContain('No query dispatches on an edge type')
  })

  it('validates an unconsumed type exactly as strictly as a consumed one — on the live validator', () => {
    // The whole point of the record: these eight are not second-class members.
    // A record that spells one of them out is legal today, and it stays legal.
    for (const type of DELIBERATELY_NOT_CONSUMED) {
      const record = baseRecord({ links: [{ type, ref: 'cart-abandon-rate' }] })
      expect(checkLinks(record), `unconsumed type "${type}" must still validate clean`).toEqual([])
      expect(validateRecord(record).errors).toEqual([])
    }
    for (const type of CONSUMED_ELSEWHERE) {
      const record = baseRecord({ links: [{ type, ref: 'cart-abandon-rate' }] })
      expect(checkLinks(record), `consumed type "${type}" must validate clean`).toEqual([])
    }
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

// ── The projection: computed from the records, never stored ─────────────────

/** A parsed-note stand-in in readCorpus's shape: {file, frontmatter, body}. */
function parsedNote(id: string, links?: Array<Record<string, unknown>>): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = { ...baseRecord({ id, claim: `Synthetic ${id}.` }) }
  if (links) frontmatter.links = links
  return { file: `${id}.md`, frontmatter, body: `Body of ${id}.\n` }
}

/** The on-disk text of a v2 record, with `links` in the canon {type, ref} shape. */
function noteText(id: string, links: Array<{ type: string; ref: string }> = []): string {
  const block = links.length
    ? `links:\n${links.map((l) => `  - type: ${l.type}\n    ref: ${l.ref}`).join('\n')}\n`
    : ''
  return (
    `---\nid: ${id}\nschema_version: 2\nstatus: active\nmemory_type: semantic\n` +
    `truth_mode: factual\nclaim: Synthetic ${id}.\nlanguage: en\nsensitivity: internal\n` +
    `${block}---\n\nBody of ${id}.\n`
  )
}

function writeCorpus(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-links-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8')
  return dir
}

/** Follow `supersedes` edges from a starting id until the chain ends. */
function walkSupersedes(graph: { bySource: Record<string, Array<{ type: string; to: string }>> }, start: string): string {
  let current = start
  const seen = new Set([current])
  for (;;) {
    const next = (graph.bySource[current] ?? []).find((e) => e.type === 'supersedes')
    if (!next || seen.has(next.to)) return current
    current = next.to
    seen.add(current)
  }
}

describe('projectLinks — a graph value, one entry per valid edge, keyed by source', () => {
  it('names the projection shape it produces', () => {
    expect(typeof LINK_PROJECTION_VERSION).toBe('string')
    expect(LINK_PROJECTION_VERSION.length).toBeGreaterThan(0)
    expect(projectLinks([]).version).toBe(LINK_PROJECTION_VERSION)
  })

  it('projects one edge per valid links entry, keyed by source id', () => {
    const graph = projectLinks([
      parsedNote('checkout-latency-budget', [
        { type: 'supports', ref: 'cart-abandon-rate' },
        { type: 'verified_by', ref: 'shop-load-test' },
      ]),
      parsedNote('cart-abandon-rate'),
      parsedNote('shop-load-test'),
    ])
    expect(graph.edges).toEqual([
      { from: 'checkout-latency-budget', type: 'supports', to: 'cart-abandon-rate' },
      { from: 'checkout-latency-budget', type: 'verified_by', to: 'shop-load-test' },
    ])
    expect(graph.bySource['checkout-latency-budget']).toHaveLength(2)
    expect(graph.refused).toEqual([])
    expect(graph.dangling).toEqual([])
  })

  it('accepts a bare frontmatter record as well as a parsed note', () => {
    const bare = { id: 'a', links: [{ type: 'supports', ref: 'b' }] }
    const graph = projectLinks([bare, { id: 'b' }])
    expect(graph.edges).toEqual([{ from: 'a', type: 'supports', to: 'b' }])
  })

  it('reports an edge checkLinks refuses in a `refused` list and keeps it out of the graph', () => {
    const graph = projectLinks([
      parsedNote('a', [
        { type: 'inspired_by', ref: 'b' },
        { type: 'supports', ref: 'b' },
      ]),
      parsedNote('b'),
    ])
    expect(graph.edges).toEqual([{ from: 'a', type: 'supports', to: 'b' }])
    expect(graph.refused).toHaveLength(1)
    expect(graph.refused[0].from).toBe('a')
    expect(graph.refused[0].type).toBe('inspired_by')
    expect(String(graph.refused[0].reason)).toContain('inspired_by')
  })

  it('reports a malformed entry rather than silently dropping it', () => {
    const graph = projectLinks([parsedNote('a', [{ type: 'supports' }]), parsedNote('b')])
    expect(graph.edges).toEqual([])
    expect(graph.refused).toHaveLength(1)
    expect(String(graph.refused[0].reason)).toContain('ref')
  })

  it('reports a ref that names no record in the corpus as dangling and excludes it', () => {
    const graph = projectLinks([parsedNote('a', [{ type: 'supports', ref: 'ghost-record' }]), parsedNote('b')])
    expect(graph.edges).toEqual([])
    expect(graph.bySource.a).toBeUndefined()
    expect(graph.dangling).toEqual([{ from: 'a', type: 'supports', ref: 'ghost-record' }])
  })

  it('is deterministic: input order does not change the output', () => {
    const notes = [
      parsedNote('c', [{ type: 'supports', ref: 'a' }]),
      parsedNote('a', [{ type: 'requires', ref: 'b' }]),
      parsedNote('b', [{ type: 'part_of', ref: 'c' }]),
    ]
    const first = projectLinks(notes)
    const second = projectLinks([notes[2], notes[0], notes[1]])
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('resolves a three-record supersession chain to its terminal record', () => {
    const graph = projectLinks([
      parsedNote('budget-v3', [{ type: 'supersedes', ref: 'budget-v2' }]),
      parsedNote('budget-v2', [{ type: 'supersedes', ref: 'budget-v1' }]),
      parsedNote('budget-v1'),
    ])
    expect(walkSupersedes(graph, 'budget-v3')).toBe('budget-v1')
  })

  it('is pure: it does not mutate the notes it reads', () => {
    const notes = [parsedNote('a', [{ type: 'supports', ref: 'b' }]), parsedNote('b')]
    const before = JSON.stringify(notes)
    projectLinks(notes)
    expect(JSON.stringify(notes)).toBe(before)
  })

  it('tolerates an empty or absent note list', () => {
    expect(projectLinks([]).edges).toEqual([])
    expect(projectLinks(undefined as unknown as unknown[]).edges).toEqual([])
  })
})

describe('linkGraphFromCorpus — the one function here that touches the filesystem', () => {
  it('returns exactly what projectLinks returns for the same records', () => {
    const dir = writeCorpus({
      'a.md': noteText('a', [{ type: 'supports', ref: 'b' }]),
      'b.md': noteText('b', [{ type: 'requires', ref: 'a' }]),
    })
    try {
      const fromDisk = linkGraphFromCorpus({ corpusDir: dir })
      const fromNotes = projectLinks([
        { id: 'a', links: [{ type: 'supports', ref: 'b' }] },
        { id: 'b', links: [{ type: 'requires', ref: 'a' }] },
      ])
      expect(fromDisk).toEqual(fromNotes)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes nothing: the projection is never persisted, so deleting it destroys no knowledge', () => {
    const dir = writeCorpus({
      'a.md': noteText('a', [{ type: 'supports', ref: 'b' }]),
      'b.md': noteText('b'),
    })
    try {
      const before = readdirSync(dir).sort()
      const first = linkGraphFromCorpus({ corpusDir: dir })
      expect(readdirSync(dir).sort()).toEqual(before)
      // A second call holds no cached state from the first — the graph is rebuilt
      // from the records' own links fields, every time, byte for byte.
      const second = linkGraphFromCorpus({ corpusDir: dir })
      expect(second).toEqual(first)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
      expect(readdirSync(dir).sort()).toEqual(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads through an injected fs implementation', () => {
    const files: Record<string, string> = {
      'a.md': noteText('a', [{ type: 'supports', ref: 'b' }]),
      'b.md': noteText('b'),
    }
    const fsImpl = {
      readdirSync: () => Object.keys(files),
      readFileSync: (path: string) => files[String(path).split(/[\\/]/).pop() as string],
    }
    const graph = linkGraphFromCorpus({ corpusDir: '/nowhere', fsImpl })
    expect(graph.edges).toEqual([{ from: 'a', type: 'supports', to: 'b' }])
  })

  it('returns an empty graph for a directory that does not exist, never throws', () => {
    const graph = linkGraphFromCorpus({ corpusDir: join(tmpdir(), 'sma-links-absent-xyz') })
    expect(graph.edges).toEqual([])
    expect(graph.version).toBe(LINK_PROJECTION_VERSION)
  })

  it('skips a file the grammar cannot parse instead of failing the whole projection', () => {
    const dir = writeCorpus({
      'a.md': noteText('a', [{ type: 'supports', ref: 'b' }]),
      'b.md': noteText('b'),
      'MEMORY.md': '# MEMORY\n\n- [a](a.md)\n',
      'broken.md': '---\nschema_version: 7\n---\nnot a grammar this parser knows\n',
    })
    try {
      const graph = linkGraphFromCorpus({ corpusDir: dir })
      expect(graph.edges).toEqual([{ from: 'a', type: 'supports', to: 'b' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Source-shape guard ──────────────────────────────────────────────────────

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
