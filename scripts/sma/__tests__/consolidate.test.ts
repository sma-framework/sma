/**
 * Tests for scripts/sma/lib/consolidate.mjs (Phase 9.1 Plan 12, Task 1 — B5/FI-9).
 *
 * P3 consolidation core — a PROPOSE-ONLY review pass over the memory corpus
 * (runLint contract: pure read + structured return, ZERO disk writes; the CLI
 * layer renders, a human applies):
 *
 *   - Test 1: two near-duplicate notes (same area+kind, high body token overlap)
 *     → ONE merge proposal naming both files.
 *   - Test 2: an episodic note whose tags matched >= 3 distinct task-tag-sets in
 *     the usage ledger → a PROMOTE proposal (episodic → procedural-rule);
 *     a note with fewer distinct sets is NOT proposed.
 *   - Test 3: two decision notes, same area+kind, conflicting claims, unlinked
 *     → a CONTRADICT proposal naming both files.
 *   - Test 4: digest() over a fixture usage+journal window → reflection summary
 *     listing top-cited notes and repeated incident classes.
 *   - Test 5: propose() performs ZERO disk writes — the fixture tree is
 *     byte-identical before/after AND the module source imports no write API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { propose, digest, findContradictions } from '../lib/consolidate.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const TAGS_MD = `# TAGS — closed faceted vocabulary (fixture)

## area

- tech — infrastructure, build, types, migrations.
- memory — memory system: notes, index, tags.

## kind

- decision — a locked decision with provenance.
- status — a point-in-time status snapshot.
- episodic — a single-event record (promotion candidate).
- procedural-rule — a durable how-to rule.
- reference — a lookup fact.

## phase

- Open facet: \`phase:NN\` — optional free-form tag.
`

function note(dir: string, name: string, fm: Record<string, unknown>, body = 'body\n') {
  const lines = ['---']
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'tags' && Array.isArray(v)) lines.push(`tags: [${v.join(', ')}]`)
    else lines.push(`${k}: ${v}`)
  }
  lines.push('---')
  writeFileSync(join(dir, name), lines.join('\n') + '\n' + body, 'utf8')
}

/** Write a JSONL file from an array of event objects. */
function jsonl(path: string, events: Array<Record<string, unknown>>) {
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

/** Recursive snapshot of a tree: relpath → file content (write-detection oracle). */
function snapshotTree(root: string, base = root): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name)
    if (statSync(p).isDirectory()) Object.assign(out, snapshotTree(p, base))
    else out[p.slice(base.length)] = readFileSync(p, 'utf8')
  }
  return out
}

let tmp: string
let corpusDir: string
let usageDir: string
let journalDir: string
let tagsPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-consolidate-'))
  corpusDir = join(tmp, 'corpus')
  usageDir = join(tmp, 'usage')
  journalDir = join(tmp, 'journal')
  mkdirSync(corpusDir, { recursive: true })
  mkdirSync(usageDir, { recursive: true })
  mkdirSync(journalDir, { recursive: true })
  tagsPath = join(corpusDir, 'TAGS.md')
  writeFileSync(tagsPath, TAGS_MD, 'utf8')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})

const opts = () => ({ corpusDir, tagsPath, usageDir, journalDir })

describe('consolidate.mjs — propose() merge proposals (9.1-12 test 1)', () => {
  it('Test 1: two near-duplicate notes (same area+kind, high body overlap) → one MERGE naming both', () => {
    note(
      corpusDir,
      'rule_sandbox_one.md',
      {
        description: 'Run the migration sandbox verification before pushing schema changes.',
        kind: 'procedural-rule',
        tags: ['tech'],
        'use-when': 'before pushing schema changes',
        importance: 5,
      },
      'Run the migration sandbox verification pass before pushing any schema change to the production database cluster.\n',
    )
    note(
      corpusDir,
      'rule_sandbox_two.md',
      {
        description: 'Run the migration sandbox verification pass before schema pushes land.',
        kind: 'procedural-rule',
        tags: ['tech'],
        'use-when': 'before schema pushes land',
        importance: 4,
      },
      'Run the migration sandbox verification pass before pushing any schema change to the production postgres cluster.\n',
    )
    note(
      corpusDir,
      'reference_unrelated.md',
      {
        description: 'A lookup fact about memory note indexing and tag facets.',
        kind: 'reference',
        tags: ['memory'],
        'use-when': 'looking up index facts',
        importance: 3,
      },
      'A completely different body about memory note indexing, tag facets and the generated index anchor.\n',
    )

    const res = propose(opts())
    expect(res.merges).toHaveLength(1)
    expect(res.merges[0].files).toContain('rule_sandbox_one.md')
    expect(res.merges[0].files).toContain('rule_sandbox_two.md')
    expect(res.merges[0].similarity).toBeGreaterThanOrEqual(0.5)
    // The unrelated note is never proposed for merging.
    expect(JSON.stringify(res.merges)).not.toContain('reference_unrelated.md')
  })
})

describe('consolidate.mjs — propose() promotion counters (9.1-12 test 2)', () => {
  it('Test 2: episodic note cited by >= 3 distinct task-tag-sets → PROMOTE (episodic → procedural-rule)', () => {
    note(corpusDir, 'episodic_incident_z.md', {
      description: 'One incident record about the flaky sandbox verification on Windows.',
      kind: 'episodic',
      tags: ['tech'],
      'use-when': 'reviewing sandbox flakes',
      importance: 3,
    })
    note(corpusDir, 'episodic_quiet.md', {
      description: 'Another incident record cited by too few distinct task tag sets.',
      kind: 'episodic',
      tags: ['memory'],
      'use-when': 'reviewing quiet incidents',
      importance: 3,
    })

    jsonl(join(usageDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T00:00:00.000Z', terminal: 'term-1', seq: 1, noteId: 'episodic_incident_z.md', kind: 'load', session: 's1', tags: ['tech', 'bug-lesson'] },
      { ts: '2026-07-02T00:00:00.000Z', terminal: 'term-1', seq: 2, noteId: 'episodic_incident_z.md', kind: 'load', session: 's2', tags: ['memory', 'workflow'] },
      { ts: '2026-07-03T00:00:00.000Z', terminal: 'term-1', seq: 3, noteId: 'episodic_incident_z.md', kind: 'load', session: 's3', tags: ['tech', 'release'] },
      // Same tag-set as seq 1 in a different order — must NOT count as a 4th distinct set.
      { ts: '2026-07-04T00:00:00.000Z', terminal: 'term-1', seq: 4, noteId: 'episodic_incident_z.md', kind: 'load', session: 's4', tags: ['bug-lesson', 'tech'] },
      { ts: '2026-07-01T06:00:00.000Z', terminal: 'term-1', seq: 5, noteId: 'episodic_quiet.md', kind: 'load', session: 's1', tags: ['tech'] },
      { ts: '2026-07-02T06:00:00.000Z', terminal: 'term-1', seq: 6, noteId: 'episodic_quiet.md', kind: 'load', session: 's2', tags: ['memory'] },
    ])

    const res = propose(opts())
    const promoted = res.promotions.find((p: { file: string }) => p.file === 'episodic_incident_z.md')
    expect(promoted).toBeDefined()
    expect(promoted.to).toBe('procedural-rule')
    expect(promoted.distinctTagSets).toBe(3)
    // Below-threshold note is NOT proposed (promotion, never time-decay — FI-9).
    expect(res.promotions.some((p: { file: string }) => p.file === 'episodic_quiet.md')).toBe(false)
  })
})

describe('consolidate.mjs — propose() contradiction detection (9.1-12 test 3)', () => {
  it('Test 3: two decision notes, same area+kind, conflicting claims, unlinked → CONTRADICT naming both', () => {
    note(corpusDir, 'decision_bundler_yes.md', {
      description: 'Always use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })
    note(corpusDir, 'decision_bundler_no.md', {
      description: 'Never use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })

    const res = propose(opts())
    expect(res.contradictions).toHaveLength(1)
    expect(res.contradictions[0].files).toContain('decision_bundler_yes.md')
    expect(res.contradictions[0].files).toContain('decision_bundler_no.md')
    expect(res.contradictions[0].kind).toBe('decision')
  })

  it('Test 3b: the same pair with valid_until on one note (supersession) → no CONTRADICT', () => {
    note(corpusDir, 'decision_bundler_yes.md', {
      description: 'Always use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })
    note(corpusDir, 'decision_bundler_no.md', {
      description: 'Never use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
      valid_until: '2026-07-01',
    })

    const res = propose(opts())
    expect(res.contradictions).toHaveLength(0)
  })

  it('findContradictions is exported (single shared implementation for lint MEM-CONTRADICT)', () => {
    expect(typeof findContradictions).toBe('function')
  })
})

describe('consolidate.mjs — digest() reflection summary (9.1-12 test 4)', () => {
  it('Test 4: digest over a usage+journal window lists top-cited notes and repeated incident classes', () => {
    jsonl(join(usageDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T00:00:00.000Z', terminal: 'term-1', seq: 1, noteId: 'a.md', kind: 'load', session: 's1' },
      { ts: '2026-07-02T00:00:00.000Z', terminal: 'term-1', seq: 2, noteId: 'a.md', kind: 'load', session: 's2' },
      { ts: '2026-07-03T00:00:00.000Z', terminal: 'term-1', seq: 3, noteId: 'a.md', kind: 'fire', session: 's3' },
      { ts: '2026-07-03T06:00:00.000Z', terminal: 'term-1', seq: 4, noteId: 'b.md', kind: 'load', session: 's3' },
    ])
    jsonl(join(journalDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T01:00:00.000Z', terminal: 'term-1', seq: 1, type: 'collision', actors: [], scope: null, detail: null },
      { ts: '2026-07-02T01:00:00.000Z', terminal: 'term-1', seq: 2, type: 'collision', actors: [], scope: null, detail: null },
      { ts: '2026-07-03T01:00:00.000Z', terminal: 'term-1', seq: 3, type: 'collision', actors: [], scope: null, detail: null },
      { ts: '2026-07-03T02:00:00.000Z', terminal: 'term-1', seq: 4, type: 'claim', actors: [], scope: null, detail: null },
    ])

    const d = digest({ usageDir, journalDir })
    expect(d.topCited[0].noteId).toBe('a.md')
    expect(d.topCited[0].total).toBe(3)
    expect(d.incidents.some((i: { type: string; count: number }) => i.type === 'collision' && i.count === 3)).toBe(true)
    // A one-off event class is not a REPEATED incident class.
    expect(d.incidents.some((i: { type: string }) => i.type === 'claim')).toBe(false)
    expect(typeof d.summary).toBe('string')
    expect(d.summary).toContain('a.md')
    expect(d.summary).toContain('collision')

    // propose() carries the same digest in its return shape.
    const res = propose(opts())
    expect(res.digest).toBeDefined()
    expect(Array.isArray(res.digest.topCited)).toBe(true)
  })
})

describe('consolidate.mjs — zero-writes contract (9.1-12 test 5)', () => {
  it('Test 5: propose() performs ZERO disk writes — tree byte-identical, no write API in source', () => {
    note(corpusDir, 'decision_bundler_yes.md', {
      description: 'Always use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })
    note(corpusDir, 'decision_bundler_no.md', {
      description: 'Never use webpack for the production build bundler pipeline.',
      kind: 'decision',
      tags: ['tech'],
      'use-when': 'choosing the production bundler',
      importance: 6,
    })
    jsonl(join(usageDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T00:00:00.000Z', terminal: 'term-1', seq: 1, noteId: 'decision_bundler_yes.md', kind: 'load', session: 's1', tags: ['tech'] },
    ])
    jsonl(join(journalDir, 'term-1.jsonl'), [
      { ts: '2026-07-01T01:00:00.000Z', terminal: 'term-1', seq: 1, type: 'collision', actors: [], scope: null, detail: null },
    ])

    const before = snapshotTree(tmp)
    const res = propose(opts())
    expect(res.contradictions.length).toBeGreaterThanOrEqual(1) // the pass actually ran
    const after = snapshotTree(tmp)
    expect(after).toEqual(before) // byte-identical fixture tree — zero writes

    // Source-level proof: the module imports/calls no fs write API at all.
    const src = readFileSync(join(__dirname, '..', 'lib', 'consolidate.mjs'), 'utf8')
    expect(
      /writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|createWriteStream|copyFileSync/.test(src),
    ).toBe(false)
  })
})
