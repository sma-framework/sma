/**
 * Tests for scripts/sma/lib/loader.mjs (Phase 49 Plan 09, Task 2).
 *
 * R4 deterministic loader — resolves a task's tag set into CORE + tag-matched
 * periphery with stable ordering (recency NEVER primary):
 *   - Test 1: same query twice over the same fixture → deep-equal ordered result.
 *   - Test 2: zero periphery matches → {periphery: [], matched: 0}, CORE still
 *     present, meta.note = CORE only; never an error (SPEC edge: empty R4).
 *   - Test 3: an alias query == its canonical query; a note matched via two of the
 *     query's tags loads ONCE (dedup after resolution — SPEC edge: adjacency R4).
 *   - Test 4: equal importance + equal date → name-asc tiebreak (SPEC edge: ordering R4).
 *   - Test 5: facet semantics — {area:[tech], kind:[procedural-rule]} matches notes
 *     with tech AND procedural-rule; {area:[tech, memory]} matches tech OR memory
 *     (AND across facets, OR within a facet — B1 intersection).
 *   - Test 6 (D-9-15): the set-query «bug-lesson + parser» returns exactly the
 *     fixture's bug-lesson notes carrying the parser topic tag.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePeriphery, orderNotes } from '../lib/loader.mjs'

const TAGS_MD = `# TAGS

## area
- tech — infra, build, migrations. · aliases: infra
- memory — memory system: notes, index. · aliases: sma, notes
- messaging — channels. · aliases: sms, push

## kind
- procedural-rule — a how-to rule. · aliases: rule
- decision — a locked decision.
- reference — a lookup fact.
- bug-lesson — a lesson from a bug. · aliases: lesson, gotcha

## phase
- Open facet: phase:NN.
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

let corpusDir: string
let tagsPath: string

const dateMap: Record<string, string> = {
  'core1.md': '2026-07-01T00:00:00Z',
  'tech-rule.md': '2026-06-01T00:00:00Z',
  'tech-ref.md': '2026-06-01T00:00:00Z',
  'mem-ref.md': '2026-05-01T00:00:00Z',
  'lesson-parser.md': '2026-06-15T00:00:00Z',
  'lesson-other.md': '2026-06-15T00:00:00Z',
}

beforeEach(() => {
  corpusDir = mkdtempSync(join(tmpdir(), 'sma-loader-'))
  tagsPath = join(corpusDir, 'TAGS.md')
  writeFileSync(tagsPath, TAGS_MD, 'utf8')

  // CORE (importance ≥ 9): always returned regardless of the query.
  note(corpusDir, 'core1.md', {
    description: 'A CORE always-load fact',
    kind: 'status',
    tags: ['tech'],
    'use-when': 'always',
    importance: 10,
  })
  // tech AND procedural-rule.
  note(corpusDir, 'tech-rule.md', {
    description: 'A tech procedural rule',
    kind: 'procedural-rule',
    tags: ['tech'],
    'use-when': 'building',
    importance: 6,
  })
  // tech, but reference kind.
  note(corpusDir, 'tech-ref.md', {
    description: 'A tech reference fact',
    kind: 'reference',
    tags: ['tech'],
    'use-when': 'looking up',
    importance: 6,
  })
  // memory, reference kind.
  note(corpusDir, 'mem-ref.md', {
    description: 'A memory reference fact',
    kind: 'reference',
    tags: ['memory'],
    'use-when': 'memory work',
    importance: 5,
  })
  // bug-lesson carrying the parser topic — the D-9-15 target.
  note(corpusDir, 'lesson-parser.md', {
    description: 'A bug lesson about the parser',
    kind: 'bug-lesson',
    tags: ['tech', 'parser'],
    'use-when': 'touching the parser',
    importance: 7,
  })
  // bug-lesson WITHOUT the parser topic.
  note(corpusDir, 'lesson-other.md', {
    description: 'A bug lesson about something else',
    kind: 'bug-lesson',
    tags: ['messaging'],
    'use-when': 'touching messaging',
    importance: 7,
  })
})

afterEach(() => {
  rmSync(corpusDir, { recursive: true, force: true })
})

describe('loader.mjs — resolvePeriphery (R4)', () => {
  it('Test 1: same query twice → deep-equal ordered result (determinism)', () => {
    const q = { tags: ['tech'], corpusDir, tagsPath, dateMap }
    const first = resolvePeriphery(q)
    const second = resolvePeriphery(q)
    expect(second).toEqual(first)
  })

  it('Test 2: zero matches → CORE only, periphery [], matched 0, never an error', () => {
    const res = resolvePeriphery({ tags: ['seo'], corpusDir, tagsPath, dateMap })
    expect(res.periphery).toEqual([])
    expect(res.matched).toBe(0)
    expect(res.core.length).toBeGreaterThan(0)
    expect(res.core).toContain('core1.md')
    expect(res.meta?.note).toMatch(/CORE only/i)
  })

  it('Test 3: alias == canonical; a note matched via two tags loads once (dedup)', () => {
    const viaCanonical = resolvePeriphery({ tags: ['memory'], corpusDir, tagsPath, dateMap })
    const viaAlias = resolvePeriphery({ tags: ['sma'], corpusDir, tagsPath, dateMap })
    expect(viaAlias.periphery).toEqual(viaCanonical.periphery)

    // A query listing tech twice (canonical + its alias 'infra') dedups the note.
    const dedup = resolvePeriphery({ tags: ['tech', 'infra'], corpusDir, tagsPath, dateMap })
    const techRuleCount = dedup.periphery.filter((f: string) => f === 'tech-rule.md').length
    expect(techRuleCount).toBe(1)
  })

  it('Test 4: equal importance + equal date → name-asc tiebreak', () => {
    // tech-rule and tech-ref are both importance 6, same date → name asc.
    const res = resolvePeriphery({ tags: ['tech'], corpusDir, tagsPath, dateMap })
    const iRule = res.periphery.indexOf('tech-rule.md')
    const iRef = res.periphery.indexOf('tech-ref.md')
    expect(iRule).toBeGreaterThan(-1)
    expect(iRef).toBeGreaterThan(-1)
    expect(iRef).toBeLessThan(iRule) // tech-ref before tech-rule (name asc)
  })

  it('Test 5: AND across facets, OR within a facet (B1 intersection)', () => {
    // AND across facets: tech (area) AND procedural-rule (kind).
    const andRes = resolvePeriphery({
      tags: ['tech', 'procedural-rule'],
      corpusDir,
      tagsPath,
      dateMap,
    })
    expect(andRes.periphery).toContain('tech-rule.md')
    expect(andRes.periphery).not.toContain('tech-ref.md') // reference kind, excluded

    // OR within the area facet: tech OR memory.
    const orRes = resolvePeriphery({ tags: ['tech', 'memory'], corpusDir, tagsPath, dateMap })
    expect(orRes.periphery).toContain('tech-ref.md')
    expect(orRes.periphery).toContain('mem-ref.md')
  })

  it('Test 6 (D-9-15): «bug-lesson + parser» returns only the parser bug-lesson', () => {
    // kind bug-lesson AND the parser topic tag (an unknown facet-less tag matched
    // against the note tags).
    const res = resolvePeriphery({
      tags: ['bug-lesson', 'parser'],
      corpusDir,
      tagsPath,
      dateMap,
    })
    expect(res.periphery).toEqual(['lesson-parser.md'])
    expect(res.periphery).not.toContain('lesson-other.md')
  })
})

describe('loader.mjs — orderNotes (shared comparator)', () => {
  it('orders importance desc → date desc → name asc', () => {
    const notes = [
      { file: 'b.md', importance: 5 },
      { file: 'a.md', importance: 5 },
      { file: 'c.md', importance: 9 },
    ]
    const ordered = orderNotes(notes, {
      'a.md': '2026-01-01T00:00:00Z',
      'b.md': '2026-01-01T00:00:00Z',
      'c.md': '2026-01-01T00:00:00Z',
    }).map((n) => n.file)
    expect(ordered).toEqual(['c.md', 'a.md', 'b.md'])
  })
})
