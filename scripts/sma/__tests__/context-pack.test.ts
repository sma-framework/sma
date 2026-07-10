/**
 * Tests for scripts/sma/lib/context-pack.mjs (Phase 49.3 Plan 05, Task 2 — D-49.3-07).
 *
 *   - Test 4 (pack determinism): compilePack twice → byte-identical PACK.md + MANIFEST.json;
 *     packId is a stable short sha; no compile-time wall-clock in the bytes.
 *   - Test 5 (budget as strict priority prefix): a forced-small budget yields a strict prefix
 *     of the fixed priority order; no backfill.
 *   - Test 6 (tag derivation + substrate reuse): deriveTaskTags matches registry facets; notes
 *     arrive ONLY via the injected resolve double (its args asserted); every packed note +
 *     fragment id fires recordCitation kind 'load'.
 *   - Test 7 (profile-soft): a declared language boosts tied cards + adds a header line; a null
 *     profile compiles identically minus those effects.
 *   - Test 8 (purity + insufficient-data honesty): scorePurity counts only >=3-touch packs;
 *     fewer than 5 settled → purityPct -1.
 *   - Test 9 (exam growth + replay): growExam turns outside touches into questions; appendMiss
 *     records a manual one; runExam replays through an injected compile and counts absences.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deriveTaskTags,
  compilePack,
  packId,
  scorePurity,
  growExam,
  appendMiss,
  runExam,
} from '../lib/context-pack.mjs'
import { buildCatalog, readCatalog } from '../lib/catalog.mjs'
import { loadTagsRegistry } from '../lib/frontmatter.mjs'

const EMDASH = String.fromCharCode(0x2014)

let dir: string
let corpusDir: string

const TAGS =
  `## area\n- crm ${EMDASH} customer relationship\n- payload ${EMDASH} the cms\n- auth ${EMDASH} authentication\n\n## kind\n- bug-lesson ${EMDASH} a burn\n`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-pack-'))
  corpusDir = join(dir, 'memory')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(join(corpusDir, 'TAGS.md'), TAGS, 'utf8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A catalog fixture (cards with empty git ISO so the pack carries no timestamp). */
function makeCatalog(tree: Record<string, string>) {
  const readFile = (p: string) => tree[p]
  const gitStats: Record<string, { lastCommit: string; commits: number }> = {}
  for (const p of Object.keys(tree)) gitStats[p] = { lastCommit: '', commits: 1 }
  const built = buildCatalog({ trackedFiles: Object.keys(tree), readFile, gitStats, commit: 'deadbeef' })
  return readCatalog({ catalogDir: '', readFile: () => built.text })
}

function writeFragment(id: string, trigger: string, tags: string[], body = 'a fact.') {
  const fragDir = join(corpusDir, 'fragments')
  mkdirSync(fragDir, { recursive: true })
  const fm = ['---', `id: ${id}`, `trigger: ${trigger}`, `tags: [${tags.join(', ')}]`, '---', body].join('\n') + '\n'
  writeFileSync(join(fragDir, `${id}.md`), fm, 'utf8')
}

describe('deriveTaskTags (Test 6a)', () => {
  it('matches registered facets, ignores unknown tokens, deduped + sorted', () => {
    const registry = loadTagsRegistry(join(corpusDir, 'TAGS.md'))
    expect(deriveTaskTags('wire the payload hook in crm', registry)).toEqual(['crm', 'payload'])
    expect(deriveTaskTags('nothing here matches', registry)).toEqual([])
  })
})

describe('compilePack — determinism (Test 4)', () => {
  it('is byte-identical across calls and carries a stable packId + no compile clock', () => {
    const catalog = makeCatalog({ 'src/crm/x.ts': 'export function handler() {}\n' })
    const resolve = () => ({ core: [], periphery: [] })
    const args = { taskText: 'fix the crm handler', commit: 'abc1234', corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), catalog, profile: null, resolve }

    const a = compilePack(args)
    const b = compilePack(args)
    expect(a.packMd).toBe(b.packMd)
    expect(a.manifestJson).toBe(b.manifestJson)
    expect(a.packId).toBe(packId('fix the crm handler', 'abc1234'))
    expect(a.packId).toHaveLength(12)
    // no compile-time ISO timestamp leaked into the bytes
    expect(a.packMd).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    expect(a.manifestJson).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    // the manifest carries its own falsifiable prediction
    expect(a.manifest.prediction).toEqual({ claim: 'session touches no file outside files[]', metric: 'pack_purity' })
  })
})

describe('compilePack — budget as strict prefix (Test 5)', () => {
  it('a small budget yields a strict prefix of the priority order, no backfill', () => {
    const tree: Record<string, string> = {}
    for (let i = 0; i < 8; i++) tree[`src/auth/f${i}.ts`] = `export const AUTH_${i} = ${i}\n`
    const catalog = makeCatalog(tree)
    const resolve = () => ({ core: [], periphery: [] })
    const base = { taskText: 'auth work', commit: 'c', corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), catalog, profile: null, resolve }

    const full = compilePack({ ...base, budget: 100000 })
    const small = compilePack({ ...base, budget: full.manifest.members[0].bytes + 300 })
    // small.members is a strict prefix of full.members
    expect(small.manifest.members.length).toBeLessThan(full.manifest.members.length)
    expect(small.manifest.members.length).toBeGreaterThan(0)
    const fullIds = full.manifest.members.map((m: { id: string }) => m.id)
    const smallIds = small.manifest.members.map((m: { id: string }) => m.id)
    expect(smallIds).toEqual(fullIds.slice(0, smallIds.length))
  })
})

describe('compilePack — substrate reuse + citation (Test 6)', () => {
  it('passes derived tags to the injected resolve and cites every packed note + fragment as load', () => {
    const catalog = makeCatalog({ 'src/crm/x.ts': 'export function h() {}\n' })
    writeFragment('crm-fact', 'tag:crm', ['crm'], 'a crm fact.')
    // note files so the pointer description read is exercised (fail-soft otherwise)
    writeFileSync(join(corpusDir, 'note-a.md'), '---\ndescription: core note a\nkind: reference\ntags: [crm]\nimportance: 9\n---\nbody\n', 'utf8')
    writeFileSync(join(corpusDir, 'note-b.md'), '---\ndescription: periphery note b\nkind: reference\ntags: [crm]\nimportance: 4\n---\nbody\n', 'utf8')

    const resolve = vi.fn(() => ({ core: ['note-a.md'], periphery: ['note-b.md'] }))
    const cite = vi.fn()
    const res = compilePack({ taskText: 'do crm things', commit: 'c', corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), catalog, profile: null, resolve, cite })

    // resolve got the derived tags
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0].tags).toEqual(['crm'])

    // every packed note + fragment id cited with kind 'load'
    const loadIds = cite.mock.calls.filter((c) => c[1] === 'load').map((c) => c[0])
    expect(loadIds).toEqual(expect.arrayContaining(['note-a.md', 'note-b.md', 'crm-fact']))
    // fragment made it into the pack (tag-trigger matched at compile time)
    expect(res.manifest.members.some((m: { type: string; id: string }) => m.type === 'fragment' && m.id === 'crm-fact')).toBe(true)
  })
})

describe('compilePack — profile-soft (Test 7)', () => {
  it('boosts tied cards of a declared language + adds a header line; null profile is identical minus effects', () => {
    // two cards tie on the 'auth' path token; a.py sorts before b.ts by path asc.
    const catalog = makeCatalog({ 'auth/a.py': 'x = 1\n', 'auth/b.ts': 'export const y = 1\n' })
    const resolve = () => ({ core: [], periphery: [] })
    const base = { taskText: 'auth', commit: 'c', corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), catalog, resolve }

    const withProfile = compilePack({ ...base, profile: { stack: { languages: ['ts'] }, workingStyle: { sessionRhythm: 'long-focus' } } })
    const withoutProfile = compilePack({ ...base, profile: null })

    const cardPaths = (r: { manifest: { members: { type: string; path: string }[] } }) =>
      r.manifest.members.filter((m) => m.type === 'card').map((m) => m.path)

    // boost: b.ts (js) ranks before a.py despite path order
    expect(cardPaths(withProfile)).toEqual(['auth/b.ts', 'auth/a.py'])
    // no profile: pure path asc
    expect(cardPaths(withoutProfile)).toEqual(['auth/a.py', 'auth/b.ts'])

    // header style line present only with a workingStyle
    expect(withProfile.packMd).toContain('style:')
    expect(withProfile.packMd).toContain('sessionRhythm: long-focus')
    expect(withoutProfile.packMd).not.toContain('style:')
  })
})

// ── purity + exam helpers ────────────────────────────────────────────────────

function writePack(contextDir: string, id: string, files: string[], touchPaths: string[], task = 'some task') {
  const packDir = join(contextDir, 'packs', id)
  mkdirSync(packDir, { recursive: true })
  const manifest = { packId: id, v: 1, commit: 'c', task, files, prediction: { claim: 'x', metric: 'pack_purity' } }
  writeFileSync(join(packDir, 'MANIFEST.json'), JSON.stringify(manifest), 'utf8')
  const lines = touchPaths.map((p, i) => JSON.stringify({ ts: `2026-07-09T00:00:0${i}Z`, path: p, windowToken: 'w' }))
  writeFileSync(join(packDir, 'touched.jsonl'), lines.join('\n') + '\n', 'utf8')
}

describe('scorePurity — insufficient-data honesty (Test 8)', () => {
  it('counts only >=3-touch packs; <5 settled → -1', () => {
    const contextDir = join(dir, 'context')
    // 3 settled packs (all inside) → below the 5-pack floor → -1
    for (let i = 0; i < 3; i++) writePack(contextDir, `p${i}`, ['a.ts'], ['a.ts', 'a.ts', 'a.ts'])
    // a 2-touch pack is NOT settled → excluded
    writePack(contextDir, 'small', ['a.ts'], ['a.ts', 'a.ts'])
    expect(scorePurity({ contextDir })).toMatchObject({ purityPct: -1, settledPacks: 3 })

    // 5 settled packs → a real percentage
    const cd2 = join(dir, 'context2')
    for (let i = 0; i < 4; i++) writePack(cd2, `q${i}`, ['a.ts'], ['a.ts', 'a.ts', 'a.ts', 'a.ts'])
    writePack(cd2, 'q4', ['a.ts'], ['a.ts', 'a.ts', 'a.ts', 'other.ts']) // 1 outside of 4
    const scored = scorePurity({ contextDir: cd2 })
    expect(scored.settledPacks).toBe(5)
    // 19 inside / 20 total = 95
    expect(scored.purityPct).toBe(95)
  })
})

describe('growExam + appendMiss + runExam (Test 9)', () => {
  it('grows exam questions from outside touches, records a manual miss, and replays them', () => {
    const contextDir = join(dir, 'context')
    writePack(contextDir, 'p0', ['a.ts'], ['a.ts', 'a.ts', 'outside.ts'], 'wire the widget')

    const grown = growExam({ contextDir })
    expect(grown.added).toBe(1)
    const examLines = readFileSync(join(contextDir, 'exam.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(examLines[0]).toMatchObject({ query: 'wire the widget', expected: 'outside.ts' })

    // dedup: a second grow adds nothing
    expect(growExam({ contextDir }).added).toBe(0)

    // manual miss
    expect(appendMiss({ query: 'find the config loader', expected: 'src/config.ts', contextDir }).added).toBe(1)

    // corrupt line tolerated
    writeFileSync(join(contextDir, 'exam.jsonl'), readFileSync(join(contextDir, 'exam.jsonl'), 'utf8') + 'not json\n', 'utf8')

    // replay: a compile that never includes the expected path → every question fails
    const failAll = runExam({ contextDir, compile: () => ({ files: ['unrelated.ts'] }) })
    expect(failAll.count).toBe(2)
    // a compile that returns the expected path → that question passes
    const partial = runExam({ contextDir, compile: (q: string) => ({ files: q === 'wire the widget' ? ['outside.ts'] : [] }) })
    expect(partial.count).toBe(1)
  })
})
