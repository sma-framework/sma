/**
 * Tests for scripts/sma/lib/loader.mjs (Phase 9 Plan 09, Task 2).
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
 *   - Test 6: the set-query «bug-lesson + parser» returns exactly the
 *     fixture's bug-lesson notes carrying the parser topic tag.
 *
 * SCHEMA-V2 VISIBILITY: the loader used to read v1 field names only
 * (tags/kind/importance), so a schema-v2 record — which carries retrieval.areas,
 * memory_type and context_priority instead — resolved as importance 0 with no
 * tags and was invisible to BOTH core and facet matching. The v2 block below
 * pins the projection the generator already writes with (one axis, no second
 * vocabulary), and the v1 block above stays byte-identical.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePeriphery, orderNotes } from '../lib/loader.mjs'
import { buildAreaIndexes } from '../lib/generator.mjs'

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
  // bug-lesson carrying the parser topic — the set-query target.
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

  it('Test 6: «bug-lesson + parser» returns only the parser bug-lesson', () => {
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

describe('loader.mjs — v1 selection is pinned (regression guard)', () => {
  it('the v1 fixture resolves to the exact same core + periphery as before the v2 fix', () => {
    const res = resolvePeriphery({ tags: ['tech'], corpusDir, tagsPath, dateMap })
    expect(res.core).toEqual(['core1.md'])
    // weight desc → date desc → name asc: lesson-parser (7, 06-15) then the two
    // importance-6 notes on the same date, name-asc.
    expect(res.periphery).toEqual(['lesson-parser.md', 'tech-ref.md', 'tech-rule.md'])
    expect(res.matched).toBe(3)
  })
})

// ── schema v2 ──────────────────────────────────────────────────────────────

const V2_TAGS_MD = `# TAGS

## area
- tech — infra, build, migrations. · aliases: infra
- memory — memory system: notes, index. · aliases: sma, notes

## kind
- procedural-rule — a how-to rule.
- bug-lesson — a lesson from a bug.
`

/** Write a raw schema-v2 record (nested retrieval block — not the v1 helper's shape). */
function v2note(
  dir: string,
  name: string,
  fm: { claim: string; memoryType?: string; status?: string; priority?: string; areas?: string[] },
) {
  const lines = [
    '---',
    `id: ${name.replace(/\.md$/, '')}`,
    'schema_version: 2',
    `status: ${fm.status ?? 'active'}`,
    'migrated_from: v1',
    `memory_type: ${fm.memoryType ?? 'procedural'}`,
    'truth_mode: normative',
    `claim: ${fm.claim}`,
    `context_priority: ${fm.priority ?? 'on-demand'}`,
  ]
  if (fm.areas && fm.areas.length) {
    lines.push('retrieval:')
    lines.push(`  areas: [${fm.areas.join(', ')}]`)
  }
  lines.push('---')
  writeFileSync(join(dir, name), lines.join('\n') + '\nbody\n', 'utf8')
}

describe('loader.mjs — schema-v2 records are visible', () => {
  let v2Dir: string
  let v2TagsPath: string

  beforeEach(() => {
    v2Dir = mkdtempSync(join(tmpdir(), 'sma-loader-v2-'))
    v2TagsPath = join(v2Dir, 'TAGS.md')
    writeFileSync(v2TagsPath, V2_TAGS_MD, 'utf8')

    // context_priority: always — the v2 way of saying «CORE» (v2 has no importance).
    v2note(v2Dir, 'v2-always.md', {
      claim: 'A v2 always-load rule',
      priority: 'always',
      areas: ['tech'],
    })
    // on-demand, area memory — must arrive through a facet query, never in core.
    v2note(v2Dir, 'v2-ondemand.md', {
      claim: 'A v2 on-demand fact about the memory system',
      areas: ['memory'],
    })
    // superseded + always — the hard filter outranks the priority.
    v2note(v2Dir, 'v2-superseded.md', {
      claim: 'A v2 rule that has been superseded',
      status: 'superseded',
      priority: 'always',
      areas: ['tech'],
    })
  })

  afterEach(() => {
    rmSync(v2Dir, { recursive: true, force: true })
  })

  it('context_priority: always puts a v2 record in CORE', () => {
    const res = resolvePeriphery({ tags: [], corpusDir: v2Dir, tagsPath: v2TagsPath })
    expect(res.core).toContain('v2-always.md')
  })

  it('retrieval.areas answer an area facet query (on-demand → periphery)', () => {
    const res = resolvePeriphery({ tags: ['memory'], corpusDir: v2Dir, tagsPath: v2TagsPath })
    expect(res.periphery).toContain('v2-ondemand.md')
    expect(res.core).not.toContain('v2-ondemand.md')
  })

  it('an area alias resolves for a v2 record exactly as for a v1 note', () => {
    const canonical = resolvePeriphery({ tags: ['memory'], corpusDir: v2Dir, tagsPath: v2TagsPath })
    const alias = resolvePeriphery({ tags: ['sma'], corpusDir: v2Dir, tagsPath: v2TagsPath })
    expect(alias.periphery).toEqual(canonical.periphery)
  })

  // CHANGED with the read-time hard filters: `status` used to be enforced only at
  // CORE membership, so a superseded record still rode into the DELIVERED periphery
  // — the very shape the retrieval baseline caught as a forbidden hit («a rule known
  // to be wrong, quoted back at the task»). §9.1's contract is that status is decided
  // before any ranking, on every output point. Findability is unchanged and lives
  // where the doc always said it does: the area index catalogues it with the state
  // named — a map, not a payload.
  it('status superseded reaches NEITHER core NOR periphery, yet stays findable via its area index', () => {
    const res = resolvePeriphery({ tags: ['tech'], corpusDir: v2Dir, tagsPath: v2TagsPath })
    expect(res.core).not.toContain('v2-superseded.md')
    expect(res.periphery).not.toContain('v2-superseded.md')

    const areas = buildAreaIndexes({ corpusDir: v2Dir, tagsPath: v2TagsPath, commitHash: 'x', dateMap: {} })
    const techIndex = areas.find((a: { file: string }) => a.file === 'INDEX-tech.md')
    expect(techIndex?.content).toContain('(v2-superseded.md)')
    expect(techIndex?.content).toContain('status: superseded')
  })

  it('coreThreshold Infinity empties CORE even for an always-priority record (reflex contract)', () => {
    const res = resolvePeriphery({
      tags: ['tech'],
      corpusDir: v2Dir,
      tagsPath: v2TagsPath,
      coreThreshold: Infinity,
    })
    expect(res.core).toEqual([])
    expect(res.periphery).toContain('v2-always.md')
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

/**
 * Read-time hard filters in the delivery chain (§9.1: «hard filters run before any
 * ranking»). The predicate lives in generator.mjs beside the CORE-membership rule —
 * one axis, one implementation — and the loader applies it as a filter chain BEFORE
 * CORE membership, facet matching and ordering are even asked. A record hidden by it
 * appears in NEITHER output point of the pack (CORE and periphery).
 */
const V2_TIME_TAGS_MD = `# TAGS

## area
- tech — infra, build, migrations.
- memory — memory system. · aliases: sma

## kind
- procedural-rule — a how-to rule.
`

/** A schema-v2 record with the visibility fields the hard filters read. */
function v2timeNote(
  dir: string,
  name: string,
  fm: {
    claim: string
    status?: string
    priority?: string
    areas?: string[]
    validFrom?: string
    validUntil?: string
    sensitivity?: string
  },
) {
  const lines = [
    '---',
    `id: ${name.replace(/\.md$/, '')}`,
    'schema_version: 2',
    `status: ${fm.status ?? 'active'}`,
    'memory_type: procedural',
    'truth_mode: normative',
    `claim: ${fm.claim}`,
    'language: ru',
  ]
  if (fm.validFrom) lines.push(`valid_from: ${fm.validFrom}`)
  if (fm.validUntil) lines.push(`valid_until: ${fm.validUntil}`)
  lines.push(`context_priority: ${fm.priority ?? 'on-demand'}`)
  lines.push(`sensitivity: ${fm.sensitivity ?? 'internal'}`)
  if (fm.areas && fm.areas.length) {
    lines.push('retrieval:')
    lines.push(`  areas: [${fm.areas.join(', ')}]`)
  }
  lines.push('---')
  writeFileSync(join(dir, name), lines.join('\n') + '\nbody\n', 'utf8')
}

describe('loader.mjs — hard filters run before ranking (§9.1)', () => {
  const NOW = '2026-08-02T12:00:00Z'
  let dir: string
  let tags: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sma-loader-visible-'))
    tags = join(dir, 'TAGS.md')
    writeFileSync(tags, V2_TIME_TAGS_MD, 'utf8')

    // Expired AND always-load: the time filter outranks context_priority, exactly
    // as the status filter does — otherwise a stale rule is quoted into every session.
    v2timeNote(dir, 'expired-core.md', {
      claim: 'A waiver that stopped being true in July',
      priority: 'always',
      areas: ['tech'],
      validUntil: '2026-07-01',
    })
    // Expired, on-demand: must not arrive through a facet query either.
    v2timeNote(dir, 'expired-facet.md', {
      claim: 'An expired fact about the memory system',
      areas: ['memory'],
      validUntil: '2026-07-01',
    })
    // Live control notes — the same shapes, still in force.
    v2timeNote(dir, 'live-core.md', {
      claim: 'A live always-load rule',
      priority: 'always',
      areas: ['tech'],
      validUntil: '2026-12-31',
    })
    v2timeNote(dir, 'live-facet.md', {
      claim: 'A live fact about the memory system',
      areas: ['memory'],
    })
    // A sensitive record — visible to its owner, withheld from a lower-class audience.
    v2timeNote(dir, 'sensitive-facet.md', {
      claim: 'A sensitive fact about the memory system',
      areas: ['memory'],
      sensitivity: 'sensitive',
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('Test 4: an expired record reaches NEITHER core NOR periphery, while live ones do', () => {
    const res = resolvePeriphery({ tags: ['tech', 'memory'], corpusDir: dir, tagsPath: tags, now: NOW })
    expect(res.core).not.toContain('expired-core.md')
    expect(res.periphery).not.toContain('expired-core.md')
    expect(res.core).not.toContain('expired-facet.md')
    expect(res.periphery).not.toContain('expired-facet.md')
    // The filter is narrow: everything still in force is delivered as before.
    expect(res.core).toContain('live-core.md')
    expect(res.periphery).toContain('live-facet.md')
  })

  it('Test 4b: the same corpus BEFORE the expiry date delivers the record — the filter is time, not identity', () => {
    const res = resolvePeriphery({
      tags: ['tech', 'memory'],
      corpusDir: dir,
      tagsPath: tags,
      now: '2026-06-01T00:00:00Z',
    })
    expect(res.core).toContain('expired-core.md')
    expect(res.periphery).toContain('expired-facet.md')
  })

  it('Test 4c: sensitivity filters by audience only — the owner default withholds nothing', () => {
    const owner = resolvePeriphery({ tags: ['memory'], corpusDir: dir, tagsPath: tags, now: NOW })
    expect(owner.periphery).toContain('sensitive-facet.md')

    const delegated = resolvePeriphery({
      tags: ['memory'],
      corpusDir: dir,
      tagsPath: tags,
      now: NOW,
      audience: 'subagent',
    })
    expect(delegated.periphery).not.toContain('sensitive-facet.md')
    expect(delegated.periphery).toContain('live-facet.md')
  })

  it('Test 4d: the read path never imports the write-time approval ladder (two questions, two functions)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/sma/lib/loader.mjs'), 'utf8')
    expect(src).not.toContain('resolveApprovalPath')
    expect(src).toContain('isVisibleNow')
  })
})
