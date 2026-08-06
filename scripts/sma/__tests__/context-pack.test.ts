/**
 * Tests for scripts/sma/lib/context-pack.mjs.
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
 *   - Test 10 (note-level gold cases): scoreNoteCases scores {task, expected_notes, critical_notes,
 *     forbidden_notes} against the REAL loader selection (CORE rules + tag-matched periphery) —
 *     hit / miss / critical miss / forbidden, deterministic across runs.
 *   - Test 11 (canon-format extension, Phase 10 Plan 03): the case grammar grows ADDITIVELY —
 *     class / schema_version / should_abstain / expected_action / repo_state are OPTIONAL keys,
 *     an old case scores byte-for-byte as before, abstention is scored by the SELECTED set
 *     (never by the unconditional CORE), a repo_state case scores against its fixture corpus,
 *     and a repo_state resolving INTO the live corpus is refused instead of scored.
 *   - Test 12 (the EXPERIMENTAL lexical fusion, Phase 10 Plan 09): reciprocal-rank fusion is
 *     arithmetic anyone can check (1/(k+rank), k=60); the experiment cannot leak into the
 *     default path (no flag → byte-identical pack AND the lexical layer never called); the
 *     three ranked lists fuse deterministically with dedup, area diversity and the same
 *     strict budget prefix; and a stale index or an absent capability DEGRADES to the
 *     default order with the reason said out loud in the trace, never silently.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import {
  deriveTaskTags,
  compilePack,
  packId,
  scorePurity,
  growExam,
  appendMiss,
  runExam,
  scoreNoteCases,
  reciprocalRankFusion,
  RRF_K,
  FUSION_DEGRADED_REASON,
} from '../lib/context-pack.mjs'
import { buildCatalog, readCatalog } from '../lib/catalog.mjs'
import { loadTagsRegistry } from '../lib/frontmatter.mjs'
// The gold-case READER lives in the measurement module; Test 11 exercises the real
// read → score pipeline (a case file on disk, not a hand-built array), because the
// claim under test is precisely that an EXTENDED line survives BOTH halves of it.
import { readGoldCases } from '../lib/baseline.mjs'

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

// ── note-level gold cases (Test 10) ──────────────────────────────────────────

function writeNote(file: string, description: string, tags: string[], importance: number) {
  const fm = ['---', `description: ${description}`, 'kind: reference', `tags: [${tags.join(', ')}]`, `importance: ${importance}`, '---', 'body']
  writeFileSync(join(corpusDir, file), fm.join('\n') + '\n', 'utf8')
}

describe('scoreNoteCases — note-level gold cases (Test 10)', () => {
  it('scores hit / miss / critical miss / forbidden against the real loader selection', () => {
    writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9) // CORE (>= CORE_THRESHOLD)
    writeNote('crm-detail.md', 'a crm periphery note', ['crm'], 5) // periphery, matches a crm task
    writeNote('auth-detail.md', 'an auth note the crm task never names', ['auth'], 3) // never loads

    const opts = { corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commit: 'c' }
    const cases = [
      {
        task: 'fix the crm handler',
        expected_notes: ['core-rule.md', 'crm-detail.md', 'auth-detail.md'],
        critical_notes: ['auth-detail.md'],
        forbidden_notes: [],
      },
    ]

    const res = scoreNoteCases({ cases, ...opts })

    // the always-loaded set comes from the generator's CORE rule, not a reimplementation
    expect(res.coreLoaded).toEqual(['core-rule.md'])

    const c = res.cases[0]
    expect(c.task).toBe('fix the crm handler')
    expect(c.loaded).toEqual(['core-rule.md', 'crm-detail.md'])
    expect(c.hits).toEqual(['core-rule.md', 'crm-detail.md'])
    expect(c.missing).toEqual(['auth-detail.md'])
    expect(c.criticalMissing).toEqual(['auth-detail.md'])
    expect(c.forbiddenPresent).toEqual([])

    expect(res.totals).toMatchObject({ cases: 1, expected: 3, hits: 2, missing: 1, casesWithCriticalMiss: 1 })
  })

  it('flags a forbidden note that loads anyway, and is deterministic across runs', () => {
    writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9)
    writeNote('crm-detail.md', 'a crm periphery note', ['crm'], 5)

    const cases = [
      { task: 'fix the crm handler', expected_notes: ['crm-detail.md'], critical_notes: [], forbidden_notes: ['core-rule.md'] },
    ]
    const opts = { cases, corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commit: 'c' }

    const a = scoreNoteCases(opts)
    const b = scoreNoteCases(opts)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))

    expect(a.cases[0].forbiddenPresent).toEqual(['core-rule.md'])
    expect(a.cases[0].criticalMissing).toEqual([])
    expect(a.totals.forbiddenPresent).toBe(1)
    // no wall-clock anywhere in the report bytes
    expect(JSON.stringify(a)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })

  it('tolerates a malformed case and an unreadable corpus without throwing', () => {
    writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9)
    // a case with no task and a case whose fields are not arrays are skipped, never fatal
    const res = scoreNoteCases({
      cases: [{ expected_notes: ['x.md'] }, { task: 'crm', expected_notes: 'not-an-array' }],
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      commit: 'c',
    })
    expect(res.cases).toHaveLength(1) // only the one carrying a task text
    expect(res.cases[0].expected).toEqual([])

    const missing = scoreNoteCases({ cases: [{ task: 'crm', expected_notes: ['a.md'] }], corpusDir: join(dir, 'nope'), tagsPath: join(dir, 'nope', 'TAGS.md'), commit: 'c' })
    expect(missing.coreLoaded).toEqual([])
    expect(missing.cases[0].missing).toEqual(['a.md'])
  })
})

// ── canon-format extension: class / abstention / repo_state (Test 11) ────────

/** A note fixture in an arbitrary corpus directory (the fixture corpora of Test 11). */
function writeNoteIn(target: string, file: string, description: string, tags: string[], importance: number) {
  mkdirSync(target, { recursive: true })
  const fm = ['---', `description: ${description}`, 'kind: reference', `tags: [${tags.join(', ')}]`, `importance: ${importance}`, '---', 'body']
  writeFileSync(join(target, file), fm.join('\n') + '\n', 'utf8')
}

/** A fixture corpus: its OWN TAGS.md (a fixture vocabulary never enters the live registry). */
function makeFixtureCorpus(target: string) {
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'TAGS.md'), TAGS, 'utf8')
  return target
}

describe('scoreNoteCases — canon-format extension (Test 11)', () => {
  it('reads and scores a case carrying the new canon keys without moving the old score (A5)', () => {
    writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9)
    writeNote('crm-detail.md', 'a crm periphery note', ['crm'], 5)

    // the case file lives BESIDE the corpus, exactly as it does in production
    const casesPath = join(corpusDir, 'gold-cases.jsonl')
    const legacy = { task: 'fix the crm handler', expected_notes: ['crm-detail.md'], critical_notes: [], forbidden_notes: [] }
    const extended = {
      ...legacy,
      class: 'exact',
      schema_version: 2,
      should_abstain: false,
      expected_action: 'cite the crm rule',
      a_key_from_a_future_schema: 'ignored, never fatal',
    }
    writeFileSync(casesPath, [JSON.stringify(legacy), JSON.stringify(extended)].join('\n') + '\n', 'utf8')

    const { cases, corrupt } = readGoldCases(casesPath)
    expect(corrupt).toBe(0)
    expect(cases).toHaveLength(2)

    const res = scoreNoteCases({ cases, corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), casesDir: corpusDir, commit: 'c' })
    const [plain, rich] = res.cases

    // the new keys change NOTHING about how the old fields score
    expect(rich.loaded).toEqual(plain.loaded)
    expect(rich.hits).toEqual(plain.hits)
    expect(rich.missing).toEqual(plain.missing)
    expect(rich.criticalMissing).toEqual(plain.criticalMissing)
    expect(rich.forbiddenPresent).toEqual(plain.forbiddenPresent)

    // ...and they are REPORTED, not swallowed
    expect(plain.class).toBeNull()
    expect(plain.schemaVersion).toBe(1)
    expect(plain.abstain).toBeNull()
    expect(plain.expectedAction).toBeNull()
    expect(rich.class).toBe('exact')
    expect(rich.schemaVersion).toBe(2)
    expect(rich.expectedAction).toBe('cite the crm rule')
    expect(rich.abstain).toBeNull() // should_abstain: false is not an abstention case

    expect(res.totals).toMatchObject({ cases: 2, rejected: 0, abstainPass: 0, abstainFail: 0 })
  })

  it('scores should_abstain by the SELECTED set, distinguishably from a recall miss', () => {
    writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9) // unconditional CORE
    writeNote('crm-detail.md', 'a crm periphery note', ['crm'], 5)

    const cases = [
      { task: 'auth', class: 'abstention', should_abstain: true, expected_notes: [], critical_notes: [], forbidden_notes: [] },
      { task: 'crm', class: 'abstention', should_abstain: true, expected_notes: [], critical_notes: [], forbidden_notes: [] },
    ]
    const res = scoreNoteCases({ cases, corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), casesDir: corpusDir, commit: 'c' })
    const [held, spoke] = res.cases

    // holding back is a PASS even though unconditional CORE still arrived —
    // the selected set is what the retrieval layer CHOSE, never the always-load frame
    expect(held.loaded).toEqual(['core-rule.md'])
    expect(held.selected).toEqual([])
    expect(held.abstain).toBe('pass')

    // answering when it should have held back is a FAIL — and NOT a recall miss
    expect(spoke.selected).toEqual(['crm-detail.md'])
    expect(spoke.abstain).toBe('fail')
    expect(spoke.missing).toEqual([])
    expect(spoke.criticalMissing).toEqual([])

    expect(res.totals).toMatchObject({ cases: 2, abstainPass: 1, abstainFail: 1, missing: 0 })
  })

  it('scores a repo_state case against its fixture corpus, not the default one', () => {
    writeNote('live-only.md', 'a note of the LIVE corpus', ['crm'], 9)
    const fixture = makeFixtureCorpus(join(dir, 'fixtures', 'poisoned-memory'))
    writeNoteIn(fixture, 'fixture-note.md', 'a neutral fixture note', ['crm'], 5)

    const cases = [
      {
        task: 'crm',
        class: 'poisoned-memory',
        repo_state: '../fixtures/poisoned-memory',
        expected_notes: ['fixture-note.md'],
        critical_notes: [],
        forbidden_notes: ['live-only.md'], // the live corpus must not leak into a fixture run
      },
    ]
    const res = scoreNoteCases({ cases, corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), casesDir: corpusDir, commit: 'c' })
    const c = res.cases[0]

    expect(c.error).toBeUndefined()
    expect(c.loaded).toEqual(['fixture-note.md'])
    expect(c.hits).toEqual(['fixture-note.md'])
    expect(c.forbiddenPresent).toEqual([])
    expect(res.totals).toMatchObject({ cases: 1, rejected: 0 })
  })

  it('refuses a repo_state that resolves INTO the live corpus, instead of scoring it', () => {
    writeNote('live-only.md', 'a note of the LIVE corpus', ['crm'], 9)
    const sneaky = makeFixtureCorpus(join(corpusDir, 'fixtures', 'sneaky'))
    writeNoteIn(sneaky, 'sneaky.md', 'adversarial content parked in the live corpus', ['crm'], 5)

    const res = scoreNoteCases({
      cases: [{ task: 'crm', class: 'cross-repo-contamination', repo_state: 'fixtures/sneaky', expected_notes: ['sneaky.md'], critical_notes: ['sneaky.md'], forbidden_notes: [] }],
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      casesDir: corpusDir,
      commit: 'c',
    })
    const c = res.cases[0]

    expect(c.error).toBe('repo-state-contamination')
    expect(c.loaded).toEqual([])
    // a refused case is NOT a recall miss and NOT a critical miss — it is refused
    expect(c.missing).toEqual([])
    expect(c.criticalMissing).toEqual([])
    expect(res.totals).toMatchObject({ cases: 0, rejected: 1, casesWithCriticalMiss: 0 })

    // an absolute path is refused the same way (a case file must stay portable)
    const abs = scoreNoteCases({
      cases: [{ task: 'crm', repo_state: resolvePath(dir, 'fixtures', 'poisoned-memory') }],
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      casesDir: corpusDir,
      commit: 'c',
    })
    expect(abs.cases[0].error).toBe('repo-state-not-relative')

    // a repo_state pointing nowhere is an honest error, never a fabricated set of misses
    const gone = scoreNoteCases({
      cases: [{ task: 'crm', repo_state: '../fixtures/never-created', expected_notes: ['x.md'] }],
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      casesDir: corpusDir,
      commit: 'c',
    })
    expect(gone.cases[0].error).toBe('repo-state-missing')
    expect(gone.cases[0].missing).toEqual([])
  })

  it('scores the four legacy fields exactly as before on a minimal case (regression)', () => {
    writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9)
    writeNote('crm-detail.md', 'a crm periphery note', ['crm'], 5)
    writeNote('auth-detail.md', 'an auth note the crm task never names', ['auth'], 3)

    const cases = [
      {
        task: 'fix the crm handler',
        expected_notes: ['core-rule.md', 'crm-detail.md', 'auth-detail.md'],
        critical_notes: ['auth-detail.md'],
        forbidden_notes: ['auth-detail.md'],
      },
    ]
    const res = scoreNoteCases({ cases, corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commit: 'c' })
    const c = res.cases[0]

    expect(res.coreLoaded).toEqual(['core-rule.md'])
    expect(c.loaded).toEqual(['core-rule.md', 'crm-detail.md'])
    expect(c.hits).toEqual(['core-rule.md', 'crm-detail.md'])
    expect(c.missing).toEqual(['auth-detail.md'])
    expect(c.criticalMissing).toEqual(['auth-detail.md'])
    expect(c.forbiddenPresent).toEqual([])
    expect(res.totals).toMatchObject({ cases: 1, expected: 3, hits: 2, missing: 1, criticalMissing: 1, casesWithCriticalMiss: 1, forbiddenPresent: 0 })
  })
})

// ── the EXPERIMENTAL lexical fusion (Test 12) ────────────────────────────────

/**
 * A lexical-layer double. The real layer needs `node:sqlite` WITH the full-text
 * extension and a built index on disk; a test that required either would only ever run
 * on the machine that wrote it — the exact «works for me» the probe exists to refuse.
 * The shape is the module's own: indexStatus → {engine, summary:{stale}}, queryExact and
 * queryLexical → {results:[{id}]}.
 */
function lexicalDouble(opts: { exact?: string[]; lexical?: string[]; stale?: number; engine?: string } = {}) {
  return {
    indexStatus: vi.fn(() => ({
      engine: opts.engine ?? 'fts5',
      reason: '',
      summary: { stale: opts.stale ?? 0, exists: 1, indexed: 3, corpus_notes: 3, visible_notes: 3, engine_available: 1 },
    })),
    queryExact: vi.fn(() => ({ results: (opts.exact ?? []).map((id) => ({ id, basis: 'symbol' })) })),
    queryLexical: vi.fn(() => ({ results: (opts.lexical ?? []).map((id, i) => ({ id, score: 10 - i, rank: i + 1 })) })),
  }
}

const noteIdsOf = (r: { members: { type: string; id: string }[] }) => r.members.filter((m) => m.type === 'note').map((m) => m.id)

describe('reciprocalRankFusion — arithmetic anybody can check (Test 12a)', () => {
  it('sums 1/(k+rank) across layers with k=60, dedups, and orders totally', () => {
    expect(RRF_K).toBe(60)

    const fused = reciprocalRankFusion([
      { layer: 'facet', ids: ['x.md', 'y.md'] },
      { layer: 'lexical', ids: ['y.md', 'z.md'] },
    ])

    expect(fused.map((e: { id: string }) => e.id)).toEqual(['y.md', 'x.md', 'z.md'])
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12) // y: rank 2 in facet, rank 1 in lexical
    expect(fused[1].score).toBeCloseTo(1 / 61, 12) // x: rank 1 in facet only
    expect(fused[2].score).toBeCloseTo(1 / 62, 12) // z: rank 2 in lexical only
    // the layers that ranked a document are carried, not summarised away
    expect(fused[0].ranks).toEqual([
      { layer: 'facet', rank: 2 },
      { layer: 'lexical', rank: 1 },
    ])

    // one document appears ONCE however many layers found it
    expect(fused).toHaveLength(3)

    // a repeat inside ONE list is the same document, not a second chance at a rank
    const repeated = reciprocalRankFusion([{ layer: 'facet', ids: ['a.md', 'a.md', 'b.md'] }])
    expect(repeated.map((e: { id: string }) => e.id)).toEqual(['a.md', 'b.md'])
    expect(repeated[1].score).toBeCloseTo(1 / 62, 12) // b kept rank 2 — the duplicate did not shift it

    // an equal score breaks by id, so two runs cannot disagree
    const tied = reciprocalRankFusion([{ layer: 'facet', ids: ['b.md'] }, { layer: 'exact', ids: ['a.md'] }])
    expect(tied.map((e: { id: string }) => e.id)).toEqual(['a.md', 'b.md'])
    expect(tied[0].score).toBe(tied[1].score)
  })
})

describe('compilePack — the experiment cannot leak into the default path (Test 12b)', () => {
  it('without the flag the pack is byte-identical AND the lexical layer is never called', () => {
    writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9)
    writeNote('crm-detail.md', 'a crm periphery note', ['crm'], 5)
    const resolve = () => ({ core: ['core-rule.md'], periphery: ['crm-detail.md'] })
    const base = { taskText: 'fix the crm handler', commit: 'c', corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), resolve }

    const plain = compilePack(base)
    const lexical = lexicalDouble({ exact: ['crm-detail.md'], lexical: ['crm-detail.md', 'core-rule.md'] })
    // the layer is HANDED IN and an index path is named — and still nothing asks it anything
    const withLayerButNoFlag = compilePack({ ...base, lexical, indexPath: join(dir, 'idx.sqlite') })

    expect(withLayerButNoFlag.packMd).toBe(plain.packMd)
    expect(withLayerButNoFlag.manifestJson).toBe(plain.manifestJson)
    expect(lexical.indexStatus).not.toHaveBeenCalled()
    expect(lexical.queryExact).not.toHaveBeenCalled()
    expect(lexical.queryLexical).not.toHaveBeenCalled()

    // and the default pack still renders the core/periphery split it always did
    expect(plain.packMd).toContain('## Core notes')
    expect(plain.packMd).toContain('## Related notes')
  })
})

describe('compilePack — fusion, dedup, diversity, budget (Test 12c)', () => {
  it('fuses three ranked lists deterministically, dedups, and prefers a different area on a tie', () => {
    writeNote('a1.md', 'first crm note', ['crm'], 5)
    writeNote('a2.md', 'second crm note', ['crm'], 5)
    writeNote('b1.md', 'an auth note', ['auth'], 5)

    // three rotations of the same three ids: every document collects ranks 1, 2 and 3,
    // so all three tie EXACTLY — which is the only condition under which the diversity
    // pass is allowed to have an opinion at all.
    const resolve = () => ({ core: [], periphery: ['a1.md', 'a2.md', 'b1.md'] })
    const lexical = lexicalDouble({ exact: ['a2.md', 'b1.md', 'a1.md'], lexical: ['b1.md', 'a1.md', 'a2.md'] })
    const args = {
      taskText: 'crm and auth work',
      commit: 'c',
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      resolve,
      lexical,
      indexPath: join(dir, 'idx.sqlite'),
      experiment: 'lexical',
    }

    // fusion alone ties them and falls back to id order…
    const raw = reciprocalRankFusion([
      { layer: 'facet', ids: ['a1.md', 'a2.md', 'b1.md'] },
      { layer: 'exact', ids: ['a2.md', 'b1.md', 'a1.md'] },
      { layer: 'lexical', ids: ['b1.md', 'a1.md', 'a2.md'] },
    ])
    expect(raw.map((e: { id: string }) => e.id)).toEqual(['a1.md', 'a2.md', 'b1.md'])
    expect(raw[0].score).toBe(raw[1].score)
    expect(raw[1].score).toBe(raw[2].score)

    // …and the pack breaks that tie by AREA, so two crm notes do not sit back to back
    const res = compilePack(args)
    expect(noteIdsOf(res)).toEqual(['a1.md', 'b1.md', 'a2.md'])

    // one document, one place in the pack, however many layers found it
    expect(noteIdsOf(res)).toHaveLength(3)

    // deterministic: the same inputs give the same bytes
    expect(compilePack(args).packMd).toBe(res.packMd)
    expect(compilePack(args).manifestJson).toBe(res.manifestJson)

    // the fused pack renders in the fused ORDER and still says which notes are the frame
    const noteLines = res.packMd.split('\n').filter((l: string) => l.startsWith('- ['))
    expect(noteLines.map((l: string) => l.split(' ')[2])).toEqual(['a1.md', 'b1.md', 'a2.md'])
    expect(res.packMd).toContain('[related] a1.md')

    // the trace names which layer gave which rank — explainability covers the experiment
    const trace: { step: string; id?: string; detail?: Record<string, unknown> }[] = []
    compilePack({ ...args, trace })
    const fusionEvents = trace.filter((e) => e.step === 'fusion')
    expect(fusionEvents.map((e) => e.id)).toEqual(['a1.md', 'b1.md', 'a2.md'])
    expect(fusionEvents[0].detail).toMatchObject({
      position: 1,
      ranks: [
        { layer: 'facet', rank: 1 },
        { layer: 'exact', rank: 3 },
        { layer: 'lexical', rank: 2 },
      ],
    })
  })

  it('lets a layer contribute a note the facet selection never chose, and still obeys the budget', () => {
    writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9)
    writeNote('found-only-lexically.md', 'a note no registered facet reaches', ['auth'], 4)

    const resolve = () => ({ core: ['core-rule.md'], periphery: [] })
    const lexical = lexicalDouble({ exact: [], lexical: ['found-only-lexically.md'] })
    const args = {
      taskText: 'a task naming no registered facet',
      commit: 'c',
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      resolve,
      lexical,
      indexPath: join(dir, 'idx.sqlite'),
      experiment: 'lexical',
    }

    expect(noteIdsOf(compilePack({ ...args, experiment: undefined }))).toEqual(['core-rule.md'])
    expect(noteIdsOf(compilePack(args))).toEqual(['core-rule.md', 'found-only-lexically.md'])

    // the SAME strict-prefix rule applies to the fused order: no backfill past the cut
    const full = compilePack(args)
    // room for the header frame and exactly one note
    const small = compilePack({ ...args, budget: full.members[0].bytes + full.members[1].bytes + 1 })
    expect(noteIdsOf(small)).toEqual(noteIdsOf(full).slice(0, noteIdsOf(small).length))
    expect(noteIdsOf(small)).toEqual(['core-rule.md'])
  })
})

describe('compilePack — the experiment degrades out loud (Test 12d)', () => {
  it('a stale index or an absent capability falls back to the default order, with the reason in the trace', () => {
    writeNote('core-rule.md', 'the always-loaded rule', ['crm'], 9)
    writeNote('crm-detail.md', 'a crm periphery note', ['crm'], 5)

    const resolve = () => ({ core: ['core-rule.md'], periphery: ['crm-detail.md'] })
    const base = {
      taskText: 'fix the crm handler',
      commit: 'c',
      corpusDir,
      tagsPath: join(corpusDir, 'TAGS.md'),
      resolve,
      indexPath: join(dir, 'idx.sqlite'),
      experiment: 'lexical',
    }
    const defaultPack = compilePack({ ...base, experiment: undefined })

    for (const broken of [
      { label: 'stale', double: lexicalDouble({ stale: 1, lexical: ['crm-detail.md'] }) },
      { label: 'unavailable', double: lexicalDouble({ engine: 'unavailable', lexical: ['crm-detail.md'] }) },
    ]) {
      const trace: { step: string; verdict?: string; reason?: string }[] = []
      const res = compilePack({ ...base, lexical: broken.double, trace })

      // the pack is the DEFAULT pack, byte for byte — degrading is not a third behaviour
      expect(res.packMd).toBe(defaultPack.packMd)
      expect(res.manifestJson).toBe(defaultPack.manifestJson)
      // …and it is not asked to rank anything it cannot rank
      expect(broken.double.queryLexical).not.toHaveBeenCalled()
      // …and it SAID so
      const said = trace.filter((e) => e.step === 'fusion' && e.verdict === 'degraded')
      expect(said).toHaveLength(1)
      expect(said[0].reason).toBe(FUSION_DEGRADED_REASON)
    }
  })
})
