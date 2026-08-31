/**
 * Tests for scripts/sma/lib/start-map.mjs — the value map /sma-start shows BEFORE
 * its first question.
 *
 * The rule under test is an ORDER, not a paragraph: a newcomer must not answer
 * questions about a system they have not seen yet. So the suite pins both halves —
 * the map itself (grounded in the real repository, deterministic, EN+RU) and its
 * PLACE in the workflow (ahead of every question the onboarding asks).
 *
 *   Test 1 — renderStartMap: byte-determinism, EN+RU parity, the repo's own numbers
 *   Test 2 — the empty/non-git directory degrades instead of crashing the onboarding
 *   Test 3 — startMapSelftest prints 1 (the falsifiable check, hermetic)
 *   Test 4 — the workflow puts the map ahead of every question
 *   Test 5 — the command is dispatched and printed, and its explainer carries EN+RU
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { analyzeForMap, renderStartMap, startMapSelftest } from '../lib/start-map.mjs'

const WORKFLOW = fileURLToPath(new URL('../../../sma-core/workflows/sma-start.md', import.meta.url))
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const EXPLAINER = fileURLToPath(new URL('../explainers/start-map.md', import.meta.url))

const synth = {
  repoDir: 'X',
  empty: false,
  fileCount: 342,
  areas: [
    { dir: 'src/app', count: 200, tag: 'src-app' },
    { dir: 'docs', count: 142, tag: 'docs' },
  ],
  byKind: { 'revert-pair': 2, 'typo-chain': 1 },
  catchTotal: 3,
  corpus: { notes: 5, present: true },
}

describe('start-map — the map itself (Test 1)', () => {
  it('renders byte-identically twice and names the numbers read from the repo', () => {
    for (const lang of ['en', 'ru'] as const) {
      const r1 = renderStartMap(synth as any, { lang })
      const r2 = renderStartMap(synth as any, { lang })
      expect(r1).toBe(r2)
      expect(r1).toContain('342') // tracked files
      expect(r1).toContain('2') // areas the tree folds into
      expect(r1).toContain('3') // catches mined from the history
      expect(r1).toContain('5') // notes already in the corpus
    }
    expect(renderStartMap(synth as any, { lang: 'ru' })).toContain('Вашем проекте')
    expect(renderStartMap(synth as any, { lang: 'en' })).toContain('What SMA will do')
  })

  it('promises the same five things in both languages, and asks nothing', () => {
    const en = renderStartMap(synth as any, { lang: 'en' })
    const ru = renderStartMap(synth as any, { lang: 'ru' })
    const leads = (text: string) => text.split('\n').filter((l) => /^\d\. /.test(l)).length
    expect(leads(en)).toBe(5)
    expect(leads(ru)).toBe(leads(en))
    // A map is not an interview: no question mark anywhere in it.
    expect(en).not.toContain('?')
    expect(ru).not.toContain('?')
  })

  it('analyzeForMap reads the live tree through an injected git and never throws', () => {
    const runGit = (args: string[]) => (args[0] === 'ls-files' ? 'src/a.ts\nsrc/b.ts\ndocs/c.md' : '')
    const io = { exists: () => false, readdir: () => [], readFile: () => '' }
    const a = analyzeForMap({ repoDir: 'X', runGit, io })
    expect(a.fileCount).toBe(3)
    expect(a.empty).toBe(false)
  })
})

describe('start-map — a fresh directory still gets a map (Test 2)', () => {
  it('degrades to the fresh-project layout instead of crashing the onboarding', () => {
    const a = analyzeForMap({
      repoDir: 'X',
      runGit: () => {
        throw new Error('fatal: not a git repository')
      },
      io: { exists: () => false, readdir: () => [], readFile: () => '' },
    })
    expect(a.empty).toBe(true)
    for (const lang of ['en', 'ru'] as const) {
      const r = renderStartMap(a as any, { lang })
      expect(r.split('\n').filter((l) => /^\d\. /.test(l)).length).toBe(5)
    }
  })
})

describe('start-map — selftest (Test 3)', () => {
  it('prints 1: determinism + graceful degradation + both languages', () => {
    expect(startMapSelftest()).toBe(1)
  })
})

describe('start-map — its place in /sma-start (Test 4)', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')

  it('renders the map before the first question of the onboarding', () => {
    const map = wf.indexOf('## Stage MAP')
    expect(map).toBeGreaterThan(-1)
    expect(wf.indexOf('start-map')).toBeGreaterThan(-1)

    // Every place the workflow opens its mouth to ASK must come after the map.
    for (const asked of [
      '## Quick path for existing installs',
      '> TEACH(accountable-loop)',
      '1. **What are you building?**',
    ]) {
      const at = wf.indexOf(asked)
      expect(at).toBeGreaterThan(-1)
      expect(map).toBeLessThan(at)
    }
  })

  it('states the order as a hard rule, not as a suggestion', () => {
    const rules = wf.slice(wf.indexOf('<hard_rules>'), wf.indexOf('</hard_rules>'))
    expect(rules).toMatch(/map/i)
    expect(rules).toMatch(/before/i)
  })
})

describe('start-map — the command surface (Test 5)', () => {
  it('is dispatched by the CLI and printed in its verb list', () => {
    const cli = readFileSync(CLI, 'utf8')
    expect(cli).toContain("'start-map': cmdStartMap")
    expect(cli).toContain('|start-map|')
  })

  it('has an explainer with both language sections', () => {
    const doc = readFileSync(EXPLAINER, 'utf8')
    expect(doc).toMatch(/\n##\s*en\s*\n/)
    expect(doc).toMatch(/\n##\s*ru\s*\n/)
  })
})
