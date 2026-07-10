/**
 * Tests for scripts/sma/lib/generator.mjs (Phase 49 Plan 09, Task 1).
 *
 * R3 generator — MEMORY.md builder = CORE (always-load) + one-line-per-fact index:
 *   - Test 1: buildIndex over a fixture corpus twice with the same injected
 *     {commitHash, dateMap} → byte-identical (R3 acceptance: determinism).
 *   - Test 2: output begins with GENERATED_MARKER carrying the injected commit
 *     hash + the do-not-hand-edit warning — the exact constant lint MEM-REGEN greps.
 *   - Test 3: notes with importance ≥ threshold render in CORE with full claim +
 *     use-when; every OTHER note is exactly ONE index line (C1/B10 grammar).
 *   - Test 4: ordering within a section = importance desc → dateMap desc → name asc
 *     (ties proven by fixture).
 *   - Test 5: a kind='status' high-importance note renders in CORE's active-blockers
 *     subsection first (D-49-08: CORE = blockers + current pointer + top facts).
 *
 * Determinism: the generator NEVER reads Date.now()/mtime/HEAD in the output path;
 * commitHash + dateMap are injected. Tests never shell out.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex, buildAreaIndexes, GENERATED_MARKER, computeDateMap } from '../lib/generator.mjs'
import { resolvePeriphery } from '../lib/loader.mjs'
import { runLint } from '../lib/lint.mjs'
import { ALWAYS_LOAD_BUDGET } from '../lib/constants.mjs'

// A closed faceted TAGS.md the generator/loader read for facet grouping.
const TAGS_MD = `# TAGS

## area
- tech — infra, build, migrations.
- memory — memory system: notes, index, tags. · aliases: sma, notes
- messaging — channels. · aliases: sms, push

## kind
- procedural-rule — a how-to rule. · aliases: rule
- decision — a locked decision.
- status — current state: what is live, blocked. · aliases: state
- reference — a lookup fact.

## phase
- Open facet: phase:NN.
`

/** Write a note file with the two-shape frontmatter parseNote accepts. */
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

// A deterministic injected commit-date map (path → last-commit ISO).
const dateMap: Record<string, string> = {
  'aaa.md': '2026-01-01T00:00:00Z',
  'bbb.md': '2026-06-01T00:00:00Z',
  'ccc.md': '2026-06-01T00:00:00Z',
  'ddd.md': '2026-03-01T00:00:00Z',
  'eee.md': '2026-06-01T00:00:00Z',
  'blocker.md': '2026-07-01T00:00:00Z',
}

const HASH = 'deadbeefcafe1234'

beforeEach(() => {
  corpusDir = mkdtempSync(join(tmpdir(), 'sma-gen-'))
  tagsPath = join(corpusDir, 'TAGS.md')
  writeFileSync(tagsPath, TAGS_MD, 'utf8')

  // High-importance CORE facts:
  note(corpusDir, 'blocker.md', {
    description: 'Email SEND blocked on prod by Railway SMTP ports',
    kind: 'status',
    tags: ['tech'],
    'use-when': 'diagnosing a prod email-send failure',
    importance: 10,
  })
  note(corpusDir, 'aaa.md', {
    description: 'Always run the full test suite before pushing to main',
    kind: 'procedural-rule',
    tags: ['tech'],
    'use-when': 'before any push',
    importance: 9,
  })
  // Periphery (below the coreThreshold=9):
  note(corpusDir, 'bbb.md', {
    description: 'SMS is the primary customer channel not Push',
    kind: 'reference',
    tags: ['messaging'],
    'use-when': 'choosing an outbound channel',
    importance: 6,
  })
  note(corpusDir, 'ccc.md', {
    description: 'Memory notes live under dot-claude memory and travel with clone',
    kind: 'reference',
    tags: ['memory'],
    'use-when': 'locating a memory note',
    importance: 6,
  })
  note(corpusDir, 'ddd.md', {
    description: 'The legacy telephony vendor is abandoned do not re-propose it',
    kind: 'decision',
    tags: ['messaging'],
    'use-when': 'considering a telephony provider',
    importance: 4,
  })
  // Tie with bbb (same importance, same date) → name-asc within the area index.
  note(corpusDir, 'eee.md', {
    description: 'Email is the fallback messaging channel for offline customers',
    kind: 'reference',
    tags: ['messaging'],
    'use-when': 'routing an RU customer message',
    importance: 6,
  })
})

afterEach(() => {
  rmSync(corpusDir, { recursive: true, force: true })
})

describe('generator.mjs — buildIndex (R3)', () => {
  it('Test 1: double-run is byte-identical (determinism, R3 acceptance)', () => {
    const first = buildIndex({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    const second = buildIndex({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    expect(second).toBe(first)
  })

  it('Test 2: begins with GENERATED_MARKER carrying the commit hash + do-not-hand-edit', () => {
    const out = buildIndex({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    // The exact constant lint MEM-REGEN greps for.
    expect(out.startsWith(GENERATED_MARKER.split('{commit}')[0])).toBe(true)
    expect(GENERATED_MARKER).toContain('GENERATED')
    expect(out).toContain(HASH)
    // do-not-hand-edit warning (EN or the RU equivalent).
    expect(/do not hand-edit|не редактировать вручную/i.test(out)).toBe(true)
  })

  it('Test 3 (FI-11): CORE stays in MEMORY.md; every periphery note is ONE line in its area index (C1/B10)', () => {
    const out = buildIndex({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    // CORE notes are the two importance ≥ 9 facts — still always-loaded.
    expect(out).toContain('Email SEND blocked on prod by Railway SMTP ports')
    expect(out).toContain('Always run the full test suite before pushing to main')
    // Periphery lines LEFT MEMORY.md (the FI-11 thinning).
    expect(out).not.toContain('(bbb.md)')

    const areas = buildAreaIndexes({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    const all = areas.map((a: { content: string }) => a.content).join('\n')
    const indexLineCount = (name: string) =>
      all.split('\n').filter((l) => l.includes(`(${name})`)).length
    expect(indexLineCount('bbb.md')).toBe(1)
    expect(indexLineCount('ccc.md')).toBe(1)
    expect(indexLineCount('ddd.md')).toBe(1)

    // An index line carries kind + tags + use-when — same grammar as the old flat index.
    const bbbLine = all.split('\n').find((l) => l.includes('(bbb.md)'))!
    expect(bbbLine).toContain('reference')
    expect(bbbLine).toContain('messaging')
    expect(bbbLine).toContain('choosing an outbound channel')
  })

  it('Test 4: ordering within an area index = importance desc → date desc → name asc (ties proven)', () => {
    const areas = buildAreaIndexes({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    const messaging = areas.find((a: { file: string }) => a.file === 'INDEX-messaging.md')!
    const pos = (name: string) => messaging.content.indexOf(`(${name})`)
    // bbb and eee are both importance 6, same date → name asc → bbb before eee.
    expect(pos('bbb.md')).toBeGreaterThan(-1)
    expect(pos('bbb.md')).toBeLessThan(pos('eee.md'))
    // importance 6 (bbb/eee) outrank importance 4 (ddd).
    expect(pos('eee.md')).toBeLessThan(pos('ddd.md'))
  })

  it('Test 5: high-importance kind=status renders in CORE active-blockers subsection first', () => {
    const out = buildIndex({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    // The status blocker precedes the procedural-rule inside CORE (status subsection first).
    expect(out.indexOf('(blocker.md)')).toBeLessThan(out.indexOf('(aaa.md)'))
  })
})

// ── 49.1-13 Task 3: FI-11 index restructure — thin discovery + per-area files ──

describe('index restructure (49.1-13 task 3, FI-11)', () => {
  /** A 200-note corpus across three areas with fat descriptions. */
  function bigCorpus(): { dir: string; tags: string } {
    const dir = mkdtempSync(join(tmpdir(), 'sma-gen-big-'))
    const tags = join(dir, 'TAGS.md')
    writeFileSync(tags, TAGS_MD, 'utf8')
    const areas = ['tech', 'memory', 'messaging']
    for (let i = 0; i < 200; i++) {
      note(dir, `note${String(i).padStart(3, '0')}.md`, {
        description: `periphery fact number ${i} ` + 'd'.repeat(170),
        kind: 'reference',
        tags: [areas[i % 3]],
        'use-when': 'u'.repeat(120),
        importance: 5,
      })
    }
    // Two CORE facts so the CORE section renders too.
    note(dir, 'core-a.md', {
      description: 'A CORE always-load fact about the build',
      kind: 'status',
      tags: ['tech'],
      'use-when': 'always',
      importance: 10,
    })
    return { dir, tags }
  }

  it('Test 1: MEMORY.md = CORE + one discovery line per area with counts; ≤ 12288 bytes on a 200-note corpus', () => {
    const { dir, tags } = bigCorpus()
    try {
      const out = buildIndex({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })
      // The whole always-load payload fits the FI-11 budget.
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(ALWAYS_LOAD_BUDGET)
      // One discovery line PER AREA carrying the count + the INDEX file pointer.
      for (const area of ['tech', 'memory', 'messaging']) {
        const lines = out.split('\n').filter((l) => l.includes(`INDEX-${area}.md`))
        expect(lines.length).toBe(1)
        expect(lines[0]).toMatch(new RegExp(`${area}.*(66|67)`)) // 200/3 notes per area
      }
      // No periphery note line leaks into the always-load payload.
      expect(out).not.toContain('(note000.md)')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 2: INDEX-<area>.md carries the full one-line-per-note entries, old flat-index grammar', () => {
    const { dir, tags } = bigCorpus()
    try {
      const areas = buildAreaIndexes({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })
      expect(areas.map((a: { file: string }) => a.file).sort()).toEqual([
        'INDEX-memory.md',
        'INDEX-messaging.md',
        'INDEX-tech.md',
      ])
      const tech = areas.find((a: { file: string }) => a.file === 'INDEX-tech.md')!
      // note000 is a tech note (0 % 3 === 0) — exactly one line, full grammar.
      const line = tech.content.split('\n').find((l: string) => l.includes('(note000.md)'))!
      expect(line).toMatch(/^- \[.*\]\(note000\.md\) · reference · tech/)
      // Every area file is a GENERATED artifact carrying the commit anchor.
      for (const a of areas) {
        expect(a.content).toContain('GENERATED')
        expect(a.content).toContain(HASH)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 3: loader finds a note whose index line lives ONLY in INDEX-<area>.md (zero discoverability loss)', () => {
    const { dir, tags } = bigCorpus()
    try {
      // Materialize the new structure on disk (thin MEMORY.md + INDEX files).
      writeFileSync(join(dir, 'MEMORY.md'), buildIndex({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} }), 'utf8')
      for (const a of buildAreaIndexes({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })) {
        writeFileSync(join(dir, a.file), a.content, 'utf8')
      }
      // note001 (memory area) is catalogued ONLY in INDEX-memory.md.
      expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).not.toContain('(note001.md)')
      const res = resolvePeriphery({ tags: ['memory'], corpusDir: dir, tagsPath: tags, dateMap: {} })
      expect(res.periphery).toContain('note001.md')
      // The loader names the on-demand INDEX file it resolved through.
      expect(res.indexFiles).toContain('INDEX-memory.md')
      // INDEX files themselves are structural — never returned as notes.
      expect(res.periphery).not.toContain('INDEX-memory.md')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('Test 4: MEM-REGEN staleness validates the new structure — INDEX files included', () => {
    const { dir, tags } = bigCorpus()
    try {
      const build = () => buildIndex({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })
      const buildAreas = () => buildAreaIndexes({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })
      writeFileSync(join(dir, 'MEMORY.md'), build(), 'utf8')
      for (const a of buildAreas()) writeFileSync(join(dir, a.file), a.content, 'utf8')

      const lintOpts = {
        corpusDir: dir,
        tagsPath: tags,
        indexPath: join(dir, 'MEMORY.md'),
        generate: build,
        generateAreas: buildAreas,
      }
      const clean = runLint(lintOpts)
      expect(clean.findings.filter((f) => f.checkId === 'MEM-REGEN' && f.tier === 'critical')).toHaveLength(0)
      // MEM-ORPHAN reads the INDEX files too: no note is "absent from the index".
      expect(clean.findings.filter((f) => f.checkId === 'MEM-ORPHAN')).toHaveLength(0)

      // Hand-editing an INDEX file trips the staleness check.
      writeFileSync(join(dir, 'INDEX-tech.md'), readFileSync(join(dir, 'INDEX-tech.md'), 'utf8') + 'hand edit\n', 'utf8')
      const stale = runLint(lintOpts)
      expect(
        stale.findings.some((f) => f.checkId === 'MEM-REGEN' && f.tier === 'critical' && f.message.includes('INDEX-tech.md')),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

describe('generator.mjs — computeDateMap (injectable git)', () => {
  it('builds path→ISO from ONE git log pass via the injected runner (never shells out)', () => {
    const gitOutput = [
      '2026-07-01T00:00:00+00:00',
      '',
      '.claude/memory/blocker.md',
      '.claude/memory/aaa.md',
      '',
      '2026-06-01T00:00:00+00:00',
      '',
      '.claude/memory/bbb.md',
      '',
    ].join('\n')
    let calls = 0
    const execGit = (_args: string[]) => {
      calls++
      return gitOutput
    }
    const map = computeDateMap({ execGit })
    expect(calls).toBe(1) // ONE git log pass
    // First-seen commit date wins (files are listed newest-commit-first).
    expect(map['blocker.md']).toBe('2026-07-01T00:00:00+00:00')
    expect(map['aaa.md']).toBe('2026-07-01T00:00:00+00:00')
    expect(map['bbb.md']).toBe('2026-06-01T00:00:00+00:00')
  })
})
