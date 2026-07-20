/**
 * recall.test.ts — the STANDING recall benchmark (Phase 9.1 Plan 14, B3/B8).
 *
 * V1's 17/18 recall was a hand-run protocol executed twice (49-01, 49-16) and then
 * never re-run — memory quality could silently regress. This test turns that
 * protocol into a STANDING gate: a set of pinned queries {query, tags,
 * expectedNoteId} resolved through the loader (resolvePeriphery), scored against a
 * >= 0.95 hit-rate (scorecard metric 4).
 *
 * PORTABILITY (must run on any machine): the benchmark ships its OWN self-contained
 * mini-corpus fixture (fixtures/recall-queries.json → {tagsRegistry, corpus,
 * queries}). It NEVER reads a machine's private .claude/memory corpus — the product
 * test is corpus-independent by construction.
 *
 * HONESTY about the ceiling (B8): the ONE known V1 miss class (tag-only retrieval
 * misses a note tagged in one area when the natural query names another) is present
 * in the set, marked `knownMiss: true`, counted SEPARATELY, and asserted to still
 * miss — so the gate is honest about the ceiling AND any NEW miss fails loudly. The
 * knownMiss stays visible until the MemPalace обкатка (9.1-15) resolves it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolvePeriphery } from '../lib/loader.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'recall-queries.json')

interface CorpusNote {
  file: string
  description: string
  kind: string
  tags: string[]
  importance: number
  body?: string
}
interface RecallQuery {
  id: string
  query: string
  tags: string[]
  expectedNoteId: string
  knownMiss?: boolean
  note?: string
}
interface RecallFixture {
  tagsRegistry: { area: string[]; kind: string[] }
  corpus: CorpusNote[]
  queries: RecallQuery[]
}

const fixture: RecallFixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

/** Build a TAGS.md registry the loader can parse from the fixture's facet lists. */
function buildTagsMd(reg: { area: string[]; kind: string[] }): string {
  const lines = ['# TAGS', '', '## area']
  for (const a of reg.area) lines.push(`- ${a} — area facet ${a}.`)
  lines.push('', '## kind')
  for (const k of reg.kind) lines.push(`- ${k} — kind facet ${k}.`)
  lines.push('', '## phase', '- Open facet: phase:NN.')
  return lines.join('\n') + '\n'
}

/** Write one fixture note as a schema-shaped LF frontmatter file. */
function writeNote(dir: string, n: CorpusNote) {
  const fm = [
    '---',
    `description: ${n.description}`,
    `kind: ${n.kind}`,
    `tags: [${n.tags.join(', ')}]`,
    `use-when: ${n.file}`,
    `importance: ${n.importance}`,
    '---',
    '',
  ].join('\n')
  writeFileSync(join(dir, n.file), fm + (n.body ?? 'body\n'), 'utf8')
}

let corpusDir: string
let tagsPath: string

beforeAll(() => {
  corpusDir = mkdtempSync(join(tmpdir(), 'sma-recall-'))
  tagsPath = join(corpusDir, 'TAGS.md')
  writeFileSync(tagsPath, buildTagsMd(fixture.tagsRegistry), 'utf8')
  for (const n of fixture.corpus) writeNote(corpusDir, n)
})

afterAll(() => {
  rmSync(corpusDir, { recursive: true, force: true })
})

/** A query "resolves" iff its expectedNoteId is in the loaded CORE ∪ periphery set. */
function resolves(q: RecallQuery): boolean {
  const res = resolvePeriphery({ tags: q.tags, corpusDir, tagsPath })
  const seen = new Set<string>([...res.core, ...res.periphery])
  return seen.has(q.expectedNoteId)
}

describe('standing recall benchmark (9.1-14, B3/B8)', () => {
  it('Test 0 (fixture shape): >= 18 entries, each with query/tags/expectedNoteId in the shipped corpus', () => {
    expect(fixture.queries.length).toBeGreaterThanOrEqual(18)
    const corpusFiles = new Set(fixture.corpus.map((c) => c.file))
    for (const q of fixture.queries) {
      expect(typeof q.query).toBe('string')
      expect(q.query.length).toBeGreaterThan(0)
      expect(Array.isArray(q.tags)).toBe(true)
      expect(q.tags.length).toBeGreaterThan(0)
      expect(typeof q.expectedNoteId).toBe('string')
      // The benchmark is self-contained: every expected note ships in the corpus.
      expect(corpusFiles.has(q.expectedNoteId)).toBe(true)
    }
  })

  it('Test 1 + 2 (the >= 0.95 gate): every non-knownMiss query resolves; hit-rate clears scorecard metric 4', () => {
    const scored = fixture.queries.filter((q) => !q.knownMiss)
    const misses = scored.filter((q) => !resolves(q)).map((q) => q.id)
    // Any NEW miss fails loudly, naming the offending query id(s).
    expect(misses, `unexpected recall misses: ${misses.join(', ') || '(none)'}`).toEqual([])
    const rate = (scored.length - misses.length) / scored.length
    expect(rate).toBeGreaterThanOrEqual(0.95)
  })

  it('Test 3 (B8 ceiling honesty): the tag-only knownMiss is present, marked, and still misses — reported, not hidden', () => {
    const known = fixture.queries.filter((q) => q.knownMiss)
    // The V1 tag-only ceiling class must stay visible in the fixture.
    expect(known.length).toBeGreaterThanOrEqual(1)
    for (const q of known) {
      // If a future retrieval improvement (9.1-15) resolves it, this fails and
      // tells you to reclassify — the ceiling is never silently "fixed".
      expect(resolves(q), `knownMiss ${q.id} unexpectedly resolved — reclassify (B8 ceiling moved)`).toBe(false)
    }
    // Counted separately and surfaced, never folded into the pass rate.
    // eslint-disable-next-line no-console
    console.log(`[recall] knownMiss (B8 tag-only ceiling), reported separately: ${known.map((q) => q.id).join(', ')}`)
  })
})
