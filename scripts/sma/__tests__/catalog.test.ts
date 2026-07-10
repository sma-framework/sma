/**
 * Tests for scripts/sma/lib/catalog.mjs (Phase 49.3 Plan 05, Task 1 — D-49.3-06).
 *
 * The deterministic one-line file catalog. Every card is a pure function of (file
 * bytes, injected git data) — no LLM meaning-string, no wall-clock, no machine id.
 *   - Test 1 (card determinism + shape): buildCard twice → byte-identical; card
 *     carries ONLY {path, class, symbols, imports, git, bytes, lines}; no body text.
 *   - Test 2 (extraction js): exported/declared identifiers + import/require targets;
 *     caps hold; a hostile token with embedded newline/control chars is sanitized
 *     single-line — a card can never span lines or forge a sibling.
 *   - Test 3 (class fallback): md first heading is the sole symbol; a null byte →
 *     'binary' with empty symbols/imports; unknown ext classifies by ext token.
 *   - Test 4 (catalog build): header + one card per file sorted by path; rebuild at
 *     the same commit is byte-identical.
 *   - Test 5 (incremental == full): refreshCatalog patches only the named entries and
 *     the result is BYTE-IDENTICAL to a full buildCatalog at the new commit.
 *   - Test 6 (drift check, MEM-REGEN posture): an edited stored card → drift 1; a
 *     moved HEAD with an untouched catalog → drift 0; a missing catalog → {built:false}.
 *   - Test 7 (find ranking): ranked by token-match desc → last-commit desc → path asc;
 *     deterministic order; zero matches → [].
 */

import { describe, it, expect } from 'vitest'

import {
  CATALOG_VERSION,
  classifyFile,
  extractSymbols,
  extractImports,
  buildCard,
  buildCatalog,
  refreshCatalog,
  readCatalog,
  checkCatalog,
  findCards,
} from '../lib/catalog.mjs'

const NUL = String.fromCharCode(0)
const LF = String.fromCharCode(10)
const TAB = String.fromCharCode(9)

/** A tiny injected fixture tree: path → {content, gitStat}. */
const TREE: Record<string, { content: string; git: { lastCommit: string; commits: number } }> = {
  'src/a.ts': {
    content: "import { join } from 'node:path'\nexport function alpha() {}\nexport const AV = 1\n",
    git: { lastCommit: '2026-07-01T10:00:00Z', commits: 3 },
  },
  'src/b.mjs': {
    content: "const dep = require('./a.ts')\nexport class Beta {}\n",
    git: { lastCommit: '2026-07-05T09:00:00Z', commits: 1 },
  },
  'docs/readme.md': {
    content: '# Payload hooks guide\n\nsome prose here\n',
    git: { lastCommit: '2026-06-20T08:00:00Z', commits: 7 },
  },
}

function makeInputs(paths = Object.keys(TREE)) {
  const readFile = (p: string) => {
    if (!(p in TREE)) throw new Error('no such file ' + p)
    return TREE[p].content
  }
  const gitStats: Record<string, { lastCommit: string; commits: number }> = {}
  for (const p of paths) gitStats[p] = TREE[p].git
  return { trackedFiles: paths, readFile, gitStats }
}

describe('buildCard — determinism + shape (Test 1)', () => {
  it('is byte-identical across calls and carries only the fixed field set', () => {
    const args = { path: 'src/a.ts', content: TREE['src/a.ts'].content, gitStat: TREE['src/a.ts'].git }
    const a = buildCard(args)
    const b = buildCard(args)
    expect(a).toBe(b)

    const card = JSON.parse(a)
    expect(Object.keys(card)).toEqual(['path', 'class', 'symbols', 'imports', 'git', 'bytes', 'lines'])
    expect(card.path).toBe('src/a.ts')
    expect(card.class).toBe('js')
    expect(Object.keys(card.git)).toEqual(['lastCommit', 'commits'])
    // no file body text leaked into any field
    const flat = JSON.stringify(card)
    expect(flat).not.toContain('some prose')
    expect(flat).not.toContain('node:path' + LF)
    // no wall-clock other than the injected git ISO
    expect(card.bytes).toBeGreaterThan(0)
    expect(card.lines).toBeGreaterThan(0)
  })
})

describe('extraction — js family (Test 2)', () => {
  it('finds symbols + imports, holds caps, and sanitizes hostile tokens to one line', () => {
    const content =
      "import { x } from 'pkg-a'\n" +
      "const y = require('pkg-b')\n" +
      'export function fn1() {}\n' +
      'export const C1 = 2\n' +
      'class Local {}\n'
    expect(extractSymbols(content, 'js')).toEqual(expect.arrayContaining(['fn1', 'C1', 'Local']))
    expect(extractImports(content, 'js')).toEqual(expect.arrayContaining(['pkg-a', 'pkg-b']))

    // caps: 30 exports → only 24 symbols kept (overflow dropped from the end)
    let many = ''
    for (let i = 0; i < 30; i++) many += `export const S${i} = ${i}\n`
    const syms = extractSymbols(many, 'js')
    expect(syms.length).toBe(24)
    expect(syms[0]).toBe('S0')

    // hostile: control chars inside a candidate token → sanitized single-line
    const hostile = 'export function ev' + LF + 'il' + TAB + 'x() {}\n'
    const hs = extractSymbols(hostile, 'js')
    for (const s of hs) {
      expect(s).not.toContain(LF)
      expect(s).not.toContain(TAB)
    }
  })
})

describe('classification — fallbacks (Test 3)', () => {
  it('md heading is the sole symbol; null byte → binary; unknown ext → ext token', () => {
    expect(extractSymbols('# Title Here\nbody\n', 'md')).toEqual(['Title Here'])

    expect(classifyFile('logo.png', NUL + 'PNGDATA')).toBe('binary')
    const binCard = JSON.parse(buildCard({ path: 'logo.png', content: NUL + 'PNGDATA', gitStat: { lastCommit: '', commits: 0 } }))
    expect(binCard.class).toBe('binary')
    expect(binCard.symbols).toEqual([])
    expect(binCard.imports).toEqual([])

    expect(classifyFile('data.xyz', 'plain')).toBe('xyz')
    expect(classifyFile('Makefile', 'plain')).toBe('other')
    expect(classifyFile('a.ts', 'x')).toBe('js')
  })
})

describe('buildCatalog — header + sorted cards, byte-stable (Test 4)', () => {
  it('writes a header then one card per file sorted by path; rebuild is identical', () => {
    const { trackedFiles, readFile, gitStats } = makeInputs()
    const c1 = buildCatalog({ trackedFiles, readFile, gitStats, commit: 'abc123' })
    const c2 = buildCatalog({ trackedFiles: [...trackedFiles].reverse(), readFile, gitStats, commit: 'abc123' })
    expect(c1.text).toBe(c2.text)

    const header = JSON.parse(c1.text.split('\n')[0])
    expect(header).toEqual({ v: CATALOG_VERSION, commit: 'abc123' })
    // sorted by path: docs/readme.md < src/a.ts < src/b.mjs
    const paths = c1.cardLines.map((l) => JSON.parse(l).path)
    expect(paths).toEqual(['docs/readme.md', 'src/a.ts', 'src/b.mjs'])
  })
})

describe('refreshCatalog — incremental == full (Test 5)', () => {
  it('patches only the changed entries and byte-matches a full rebuild at the new commit', () => {
    const { trackedFiles, readFile, gitStats } = makeInputs()
    const full1 = buildCatalog({ trackedFiles, readFile, gitStats, commit: 'c1' })
    const stored = readCatalog({ catalogDir: '', readFile: () => full1.text })

    // src/a.ts is modified at commit c2 (new gitStat); nothing else changes.
    const newTree = { ...TREE, 'src/a.ts': { content: 'export function alphaV2() {}\n', git: { lastCommit: '2026-07-08T00:00:00Z', commits: 4 } } }
    const readFile2 = (p: string) => (newTree as typeof TREE)[p].content
    const gitStats2: Record<string, { lastCommit: string; commits: number }> = {}
    for (const p of Object.keys(newTree)) gitStats2[p] = (newTree as typeof TREE)[p].git

    const refreshed = refreshCatalog({ catalog: stored, changed: ['src/a.ts'], deleted: [], readFile: readFile2, gitStats: gitStats2, commit: 'c2' })
    const full2 = buildCatalog({ trackedFiles, readFile: readFile2, gitStats: gitStats2, commit: 'c2' })
    expect(refreshed.text).toBe(full2.text)

    // a deletion also matches a full rebuild without the deleted file
    const refreshedDel = refreshCatalog({ catalog: stored, changed: [], deleted: ['src/b.mjs'], readFile, gitStats, commit: 'c1' })
    const fullDel = buildCatalog({ trackedFiles: ['src/a.ts', 'docs/readme.md'], readFile, gitStats, commit: 'c1' })
    expect(refreshedDel.text).toBe(fullDel.text)
  })
})

describe('checkCatalog — drift (Test 6)', () => {
  it('edited card → drift 1; untouched catalog → drift 0; missing → not built', () => {
    const { trackedFiles, readFile, gitStats } = makeInputs()
    const full = buildCatalog({ trackedFiles, readFile, gitStats, commit: 'c1' })

    // untouched catalog regenerated at its own header commit → drift 0
    const clean = readCatalog({ catalogDir: '', readFile: () => full.text })
    expect(checkCatalog({ catalog: clean, readFile, gitStatsAtCommit: gitStats })).toMatchObject({ built: true, drift: 0 })

    // hand-edit one stored card line → drift 1
    const tampered = full.text.replace('"alpha"', '"HACKED"')
    const dirty = readCatalog({ catalogDir: '', readFile: () => tampered })
    const res = checkCatalog({ catalog: dirty, readFile, gitStatsAtCommit: gitStats })
    expect(res.drift).toBe(1)
    expect(res.driftPaths).toContain('src/a.ts')

    // missing catalog → {built:false}
    const missing = readCatalog({ catalogDir: '', readFile: () => { throw new Error('enoent') } })
    expect(checkCatalog({ catalog: missing, readFile, gitStatsAtCommit: gitStats })).toEqual({ built: false })
  })
})

describe('findCards — ranking (Test 7)', () => {
  it('ranks by token-match then last-commit then path; deterministic; zero → []', () => {
    const { trackedFiles, readFile, gitStats } = makeInputs()
    const full = buildCatalog({ trackedFiles, readFile, gitStats, commit: 'c1' })
    const catalog = readCatalog({ catalogDir: '', readFile: () => full.text })

    // 'payload hooks' matches the md heading tokens of docs/readme.md
    const hits = findCards({ catalog, query: 'payload hooks' })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].path).toBe('docs/readme.md')

    // deterministic across calls
    const again = findCards({ catalog, query: 'payload hooks' })
    expect(hits.map((c) => c.path)).toEqual(again.map((c) => c.path))

    // zero matches → []
    expect(findCards({ catalog, query: 'zzzznomatch' })).toEqual([])
  })
})
