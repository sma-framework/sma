/**
 * Tests for scripts/sma/lib/memory-preview.mjs (9.4 BL-174, v3.6 — the onboarding
 * memory-graph preview).
 *
 * The load-bearing behaviors:
 *   Test 1 — foldAreas: top-level fold, dominant-dir descent, deterministic order, cap 6
 *   Test 2 — analyzeRepo (fake git): file count + areas + corpus count; throwing git -> empty
 *   Test 3 — renderPreview: byte-determinism, EN+RU, empty-repo path, kind lines
 *   Test 4 — previewSelftest prints 1 (the P-BL-174 check, hermetic)
 */

import { describe, it, expect } from 'vitest'
import { foldAreas, analyzeRepo, renderPreview, previewSelftest } from '../lib/memory-preview.mjs'

describe('memory-preview — foldAreas (Test 1)', () => {
  it('folds by top-level dir and descends ONE level into a dominant dir', () => {
    const flat = foldAreas(['docs/a.md', 'docs/b.md', 'scripts/x.mjs'])
    expect(flat.map((a) => a.dir)).toEqual(['docs', 'scripts'])
    expect(flat[0].count).toBe(2)

    // src holds >50% -> split into src/app, src/lib
    const dom = foldAreas(['src/app/a.ts', 'src/app/b.ts', 'src/lib/c.ts', 'docs/readme.md'])
    expect(dom.map((a) => a.dir)).toContain('src/app')
    expect(dom.map((a) => a.dir)).toContain('src/lib')
    expect(dom.map((a) => a.dir)).not.toContain('src')
  })

  it('caps at 6 areas, deterministic count-then-name order, root files excluded', () => {
    const files: string[] = ['README.md']
    for (let i = 0; i < 8; i++) files.push(`d${i}/f1.ts`, `d${i}/f2.ts`)
    files.push('big/a.ts', 'big/b.ts', 'big/c.ts')
    const areas = foldAreas(files)
    expect(areas.length).toBe(6)
    expect(areas[0].dir).toBe('big')
    expect(areas.map((a) => a.dir)).not.toContain('(root)')
  })
})

describe('memory-preview — analyzeRepo (Test 2)', () => {
  const io = { exists: () => true, readdir: () => ['MEMORY.md', 'TAGS.md', 'INDEX-crm.md', 'note_a.md', 'note_b.md'], readFile: () => '' }

  it('folds a fake repo and counts only real corpus notes', () => {
    const runGit = (args: string[]) => (args[0] === 'ls-files' ? 'src/a.ts\nsrc/b.ts\ndocs/c.md' : '')
    const a = analyzeRepo({ repoDir: 'X', runGit, io })
    expect(a.empty).toBe(false)
    expect(a.fileCount).toBe(3)
    expect(a.corpus).toEqual({ notes: 2, present: true })
  })

  it('degrades to empty on a throwing git — never throws', () => {
    const a = analyzeRepo({
      repoDir: 'X',
      runGit: () => {
        throw new Error('fatal: not a git repository')
      },
      io: { exists: () => false, readdir: () => [], readFile: () => '' },
    })
    expect(a.empty).toBe(true)
    expect(a.areas).toEqual([])
    expect(a.catchTotal).toBe(0)
  })
})

describe('memory-preview — renderPreview (Test 3)', () => {
  const synth = {
    repoDir: 'X',
    empty: false,
    fileCount: 5,
    areas: [
      { dir: 'src/app', count: 3, tag: 'src-app' },
      { dir: 'docs', count: 2, tag: 'docs' },
    ],
    byKind: { 'revert-pair': 2, 'typo-chain': 1 },
    catchTotal: 3,
    corpus: { notes: 0, present: false },
  }

  it('renders byte-identically twice, in both languages', () => {
    for (const lang of ['en', 'ru'] as const) {
      const r1 = renderPreview(synth as any, { lang })
      const r2 = renderPreview(synth as any, { lang })
      expect(r1).toBe(r2)
      expect(r1).toContain('area:src-app')
      expect(r1).toContain(': 2')
      expect(r1).toContain(': 1')
    }
    expect(renderPreview(synth as any, { lang: 'ru' })).toContain('ЯДРО')
  })

  it('renders the empty-repo layout without crashing', () => {
    const empty = { ...synth, empty: true, fileCount: 0, areas: [], byKind: {}, catchTotal: 0 }
    const r = renderPreview(empty as any, { lang: 'en' })
    expect(r).toContain('no git-tracked files')
    expect(r).toContain('CORE')
  })
})

describe('memory-preview — selftest (Test 4)', () => {
  it('prints 1: determinism + graceful degradation + kind lines', () => {
    expect(previewSelftest()).toBe(1)
  })
})
