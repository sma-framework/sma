/**
 * Tests for scripts/sma/lib/emit.mjs (Phase 49.3 Plan 04 — D-49.3-08, T-49.3-03).
 *
 * `sma emit` compiles the learned memory corpus into managed export blocks in
 * CLAUDE.md / AGENTS.md / .cursorrules / GEMINI.md, each under a per-format byte
 * budget, deterministically (importance + budget), never hand-edited in place.
 *
 * Task 1 (selection + rendering):
 *   - Test 1 (eligibility): status/episodic kinds excluded; a note missing a
 *     non-empty description or a numeric importance excluded; each exclusion
 *     counted by reason.
 *   - Test 2 (ordering): ties resolve exactly like generator.mjs's makeComparator
 *     (importance desc -> injected dateMap date desc -> name asc) — emit re-derives
 *     nothing.
 *   - Test 3 (priority prefix): a budget cutoff yields a STRICT PREFIX of the
 *     priority order; iteration stops at the first overflow, no backfill.
 *   - Test 4 (determinism + budget): two renders are byte-identical; the block
 *     (anchors + preamble + entries + footer) is <= budget.
 *   - Test 5 (injection defense): a description embedding the END-anchor token and
 *     a raw newline renders as ONE defanged line; the block still parses as exactly
 *     one BEGIN/END pair.
 *   - Test 6 (per-style rendering): md anchors are HTML comments; txt anchors are
 *     `# >>> ` / `# <<< ` lines; entries carry name, kind, importance, description,
 *     and use-when when present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

import { makeComparator } from '../lib/generator.mjs'
import { EMIT_FORMATS, makeAnchors, selectNotes, renderBlock, spliceBlock, emitAll } from '../lib/emit.mjs'

/** An in-memory io double for emitAll (exists/readFile/writeFileAtomic + a write counter). */
function memIo(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const stats = { writes: 0 }
  return {
    store,
    stats,
    exists: (p: string) => store.has(p),
    readFile: (p: string) => {
      const v = store.get(p)
      if (v === undefined) throw new Error('ENOENT ' + p)
      return v
    },
    writeFileAtomic: (p: string, text: string) => {
      stats.writes++
      store.set(p, text)
    },
  }
}

let dir: string

const HASH = 'a'.repeat(40) // a valid 40-hex commit anchor

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-emit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a memory note the frontmatter parser accepts. */
function writeNote(
  name: string,
  fm: { description?: string; kind?: string; tags?: string[]; importance?: number | null; useWhen?: string },
  body = 'body text\n',
): void {
  const lines = ['---']
  if (fm.description !== undefined) lines.push(`description: ${fm.description}`)
  if (fm.kind !== undefined) lines.push(`kind: ${fm.kind}`)
  if (fm.tags !== undefined) lines.push(`tags: [${fm.tags.join(', ')}]`)
  if (fm.useWhen !== undefined) lines.push(`use-when: ${fm.useWhen}`)
  if (fm.importance !== undefined && fm.importance !== null) lines.push(`importance: ${fm.importance}`)
  lines.push('---')
  writeFileSync(join(dir, name), lines.join('\n') + '\n' + body)
}

describe('selectNotes — eligibility (Task 1, Test 1)', () => {
  it('excludes status/episodic kinds and notes missing description or numeric importance, counted by reason', () => {
    writeNote('a.md', { description: 'Rule A about pushing', kind: 'procedural-rule', importance: 8, useWhen: 'before pushing' })
    writeNote('b.md', { description: 'current position', kind: 'status', importance: 9 })
    writeNote('c.md', { description: 'session note', kind: 'episodic', importance: 7 })
    writeNote('d.md', { description: '', kind: 'reference', importance: 5 })
    writeNote('e.md', { description: 'Reference E', kind: 'reference', importance: null })

    const res = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: 8192, style: 'md', commitHash: HASH, file: 'CLAUDE.md' })

    expect(res.included.map((n: any) => n.file)).toEqual(['a.md'])
    expect(res.totalEligible).toBe(1)
    expect(res.excluded['kind-excluded']).toBe(2)
    expect(res.excluded['no-description']).toBe(1)
    expect(res.excluded['no-importance']).toBe(1)
  })
})

describe('selectNotes — ordering (Task 1, Test 2)', () => {
  it('resolves ties exactly like makeComparator: importance desc -> date desc -> name asc', () => {
    writeNote('x.md', { description: 'X', kind: 'reference', importance: 7 })
    writeNote('y.md', { description: 'Y', kind: 'reference', importance: 7 })
    writeNote('z.md', { description: 'Z', kind: 'reference', importance: 7 })
    const dateMap = {
      'x.md': '2026-01-01T00:00:00Z',
      'y.md': '2026-03-01T00:00:00Z',
      'z.md': '2026-02-01T00:00:00Z',
    }

    const res = selectNotes({ corpusDir: dir, dateMap, budgetBytes: 8192, style: 'md', commitHash: HASH, file: 'CLAUDE.md' })
    const gotOrder = res.included.map((n: any) => n.file)

    // y (Mar) -> z (Feb) -> x (Jan)
    expect(gotOrder).toEqual(['y.md', 'z.md', 'x.md'])

    // Cross-check: a direct makeComparator sort of the same records agrees.
    const direct = res.included.slice().sort(makeComparator(dateMap)).map((n: any) => n.file)
    expect(gotOrder).toEqual(direct)
  })
})

describe('selectNotes — strict priority prefix (Task 1, Test 3)', () => {
  it('stops at the first entry that would overflow; the included set is a strict prefix, no backfill', () => {
    // 8 notes, distinct importance so ordering is unambiguous, long descriptions.
    for (let i = 0; i < 8; i++) {
      writeNote(`n${i}.md`, { description: `Description number ${i} `.repeat(12).trim(), kind: 'reference', importance: 20 - i })
    }
    const full = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: 100000, style: 'md', commitHash: HASH, file: 'CLAUDE.md' })
    const fullOrder = full.included.map((n: any) => n.file)
    expect(fullOrder.length).toBe(8)

    const cut = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: 900, style: 'md', commitHash: HASH, file: 'CLAUDE.md' })
    const cutOrder = cut.included.map((n: any) => n.file)

    expect(cutOrder.length).toBeGreaterThan(0)
    expect(cutOrder.length).toBeLessThan(8)
    // strict prefix of the full priority order
    expect(cutOrder).toEqual(fullOrder.slice(0, cutOrder.length))
  })
})

describe('renderBlock — determinism + budget math (Task 1, Test 4)', () => {
  it('two renders are byte-identical and the block is within budget', () => {
    for (let i = 0; i < 6; i++) {
      writeNote(`n${i}.md`, { description: `Desc ${i}`, kind: 'reference', importance: 10 - i, useWhen: `when ${i}` })
    }
    const budget = 2048
    const sel = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: budget, style: 'md', commitHash: HASH, file: 'CLAUDE.md' })
    const fmt = EMIT_FORMATS.find((f: any) => f.id === 'claude')
    const b1 = renderBlock({ format: fmt, selection: sel, commitHash: HASH, corpusDir: dir })
    const b2 = renderBlock({ format: fmt, selection: sel, commitHash: HASH, corpusDir: dir })

    expect(b1).toBe(b2)
    expect(Buffer.byteLength(b1, 'utf8')).toBeLessThanOrEqual(budget)
  })
})

describe('renderBlock — injection defense (Task 1, Test 5)', () => {
  it('a description embedding the END-anchor token renders defanged on one line; the block stays a single BEGIN/END pair', () => {
    // A frontmatter scalar is single-line by construction; the real injection
    // vector is a note author pasting an anchor-looking token into a description.
    writeNote('evil.md', {
      description: 'before <!-- SMA:EXPORT:END --> after injection attempt',
      kind: 'reference',
      importance: 9,
    })
    const sel = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: 8192, style: 'md', commitHash: HASH, file: 'CLAUDE.md' })
    const fmt = EMIT_FORMATS.find((f: any) => f.id === 'claude')
    const block = renderBlock({ format: fmt, selection: sel, commitHash: HASH, corpusDir: dir })

    // the note WAS eligible and made it into the block
    expect(sel.included.map((n: any) => n.file)).toContain('evil.md')
    // exactly one real END anchor and one real BEGIN anchor survive (whole-line)
    expect((block.match(/^<!-- SMA:EXPORT:END -->$/gm) || []).length).toBe(1)
    expect((block.match(/^<!-- SMA:EXPORT:BEGIN/gm) || []).length).toBe(1)
    // the note's token is defanged to the dash-form
    expect(block).toContain('SMA-EXPORT-END')
    // no non-anchor line opens or closes a block (single-line entry guarantee)
    const entryLines = block.split('\n').filter((l) => l.startsWith('- '))
    for (const l of entryLines) {
      expect(l.includes('SMA:EXPORT:')).toBe(false)
    }
  })
})

describe('makeAnchors + renderBlock — per-style rendering (Task 1, Test 6)', () => {
  it('md uses HTML-comment anchors; txt uses # >>> / # <<< ; entries carry name/kind/importance/description/use-when', () => {
    const md = makeAnchors({ style: 'md', file: 'CLAUDE.md', commitHash: HASH })
    expect(md.begin.startsWith('<!-- SMA:EXPORT:BEGIN')).toBe(true)
    expect(md.end).toBe('<!-- SMA:EXPORT:END -->')

    const txt = makeAnchors({ style: 'txt', file: '.cursorrules', commitHash: HASH })
    expect(txt.begin.startsWith('# >>> SMA:EXPORT:BEGIN')).toBe(true)
    expect(txt.end).toBe('# <<< SMA:EXPORT:END')

    writeNote('r.md', { description: 'A single rule', kind: 'procedural-rule', importance: 8, useWhen: 'before pushing' })
    const selMd = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: 8192, style: 'md', commitHash: HASH, file: 'CLAUDE.md' })
    const mdFmt = EMIT_FORMATS.find((f: any) => f.id === 'claude')
    const mdBlock = renderBlock({ format: mdFmt, selection: selMd, commitHash: HASH, corpusDir: dir })
    expect(mdBlock).toContain('- **r** (procedural-rule, imp 8): A single rule [use-when: before pushing]')

    const selTxt = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: 6144, style: 'txt', commitHash: HASH, file: '.cursorrules' })
    const txtFmt = EMIT_FORMATS.find((f: any) => f.id === 'cursorrules')
    const txtBlock = renderBlock({ format: txtFmt, selection: selTxt, commitHash: HASH, corpusDir: dir })
    expect(txtBlock).toContain('- r (procedural-rule, imp 8): A single rule [use-when: before pushing]')
    expect(txtBlock).toContain('# >>> SMA:EXPORT:BEGIN')
    expect(txtBlock).toContain('# <<< SMA:EXPORT:END')
  })
})

// ─────────────────────────── Task 2: splice + emitAll + --check ───────────────

/** A minimal but valid md block for the given hash. */
function mdBlock(hash: string, body = 'body', file = 'CLAUDE.md'): string {
  const a = makeAnchors({ style: 'md', file, commitHash: hash })
  return [a.begin, '', body, a.end].join('\n')
}

describe('spliceBlock — create (Task 2, Test 1)', () => {
  it('absent target → block + one trailing LF; action created', () => {
    const block = mdBlock(HASH)
    const r = spliceBlock({ existingText: '', block, style: 'md' })
    expect(r.action).toBe('created')
    expect(r.text).toBe(block + '\n')
  })
})

describe('spliceBlock — append (Task 2, Test 2)', () => {
  it('present without a block → user content is a byte-identical prefix, one blank-line separator, action appended', () => {
    const user = '# My rules\nsome content\n'
    const block = mdBlock(HASH)
    const r = spliceBlock({ existingText: user, block, style: 'md' })
    expect(r.action).toBe('appended')
    expect(r.text.startsWith(user)).toBe(true)
    expect(r.text).toContain(block)
    expect(r.text.endsWith('\n')).toBe(true)
    // exactly one blank line between the user content and the block
    expect(r.text).toBe(user + '\n' + block + '\n')
  })
})

describe('spliceBlock — replace (Task 2, Test 3)', () => {
  it('only the BEGIN..END span changes; head and tail stay byte-identical', () => {
    const oldBlock = mdBlock('c'.repeat(40), 'OLD body')
    const existing = ['# user head', 'keep me', oldBlock, 'user tail', 'keep me too'].join('\n')
    const newBlock = mdBlock(HASH, 'NEW body')
    const r = spliceBlock({ existingText: existing, block: newBlock, style: 'md' })
    expect(r.action).toBe('replaced')
    expect(r.text.startsWith('# user head\nkeep me\n')).toBe(true)
    expect(r.text.endsWith('user tail\nkeep me too')).toBe(true)
    expect(r.text).toContain('NEW body')
    expect(r.text.includes('OLD body')).toBe(false)
  })
})

describe('spliceBlock — corrupt refusal (Task 2, Test 5)', () => {
  it('BEGIN without END, END before BEGIN, and duplicate BEGIN each → skipped-corrupt, text untouched', () => {
    const a = makeAnchors({ style: 'md', file: 'CLAUDE.md', commitHash: HASH })
    const block = mdBlock(HASH, 'NEW')

    const beginNoEnd = ['head', a.begin, 'orphan content'].join('\n')
    const r1 = spliceBlock({ existingText: beginNoEnd, block, style: 'md' })
    expect(r1.action).toBe('skipped-corrupt')
    expect(r1.text).toBe(beginNoEnd)

    const endBeforeBegin = [a.end, 'mid', a.begin].join('\n')
    const r2 = spliceBlock({ existingText: endBeforeBegin, block, style: 'md' })
    expect(r2.action).toBe('skipped-corrupt')
    expect(r2.text).toBe(endBeforeBegin)

    const dupBegin = [a.begin, 'x', a.begin, 'y', a.end].join('\n')
    const r3 = spliceBlock({ existingText: dupBegin, block, style: 'md' })
    expect(r3.action).toBe('skipped-corrupt')
    expect(r3.text).toBe(dupBegin)
  })
})

describe('emitAll — idempotence (Task 2, Test 4)', () => {
  it('two runs at the same commit → second run is unchanged for every format and writes ZERO times', () => {
    writeNote('a.md', { description: 'Rule A', kind: 'procedural-rule', importance: 8 })
    writeNote('b.md', { description: 'Rule B', kind: 'reference', importance: 6 })
    const io = memIo()

    const r1 = emitAll({ targetDir: 't', corpusDir: dir, commitHash: HASH, dateMap: {}, formats: EMIT_FORMATS, io })
    expect(r1.results.every((x: any) => x.action === 'created')).toBe(true)
    expect(io.stats.writes).toBe(4)

    const before = io.stats.writes
    const r2 = emitAll({ targetDir: 't', corpusDir: dir, commitHash: HASH, dateMap: {}, formats: EMIT_FORMATS, io })
    expect(r2.results.every((x: any) => x.action === 'unchanged')).toBe(true)
    expect(io.stats.writes).toBe(before) // ZERO new writes
  })
})

describe('emitAll — --check counts (Task 2, Test 6)', () => {
  beforeEach(() => {
    writeNote('a.md', { description: 'Rule A about pushing before deploy', kind: 'procedural-rule', importance: 8 })
    writeNote('b.md', { description: 'Reference B on migrations and slots', kind: 'reference', importance: 6 })
  })

  it('a byte edited inside an existing block → drift 1, nothing written', () => {
    const claude = EMIT_FORMATS.find((f: any) => f.id === 'claude')
    const sel = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: 8192, style: 'md', commitHash: HASH, file: 'CLAUDE.md' })
    const good = renderBlock({ format: claude, selection: sel, commitHash: HASH, corpusDir: dir })
    const edited = good.replace('exported', 'exportedX') // mutate inside the footer, anchors intact
    const io = memIo({ [join('t', 'CLAUDE.md')]: edited + '\n' })

    const r = emitAll({ targetDir: 't', corpusDir: dir, commitHash: HASH, dateMap: {}, formats: [claude], check: true, io })
    expect(r.counts.drift).toBe(1)
    expect(io.stats.writes).toBe(0)
  })

  it('a --budget override that cannot fit the scaffold → over-budget 1, nothing written', () => {
    const cursor = EMIT_FORMATS.find((f: any) => f.id === 'cursorrules')
    const sel = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: 6144, style: 'txt', commitHash: HASH, file: '.cursorrules' })
    const good = renderBlock({ format: cursor, selection: sel, commitHash: HASH, corpusDir: dir })
    const io = memIo({ [join('t', '.cursorrules')]: good + '\n' })

    const r = emitAll({
      targetDir: 't',
      corpusDir: dir,
      commitHash: HASH,
      dateMap: {},
      formats: [cursor],
      budgets: { cursorrules: 64 },
      check: true,
      io,
    })
    expect(r.counts.overBudget).toBe(1)
    expect(r.counts.drift).toBe(0)
    expect(io.stats.writes).toBe(0)
  })

  it('an older commit hash whose content matches regeneration AT that hash → drift 0 (hash parsed from the anchor)', () => {
    const OLD = 'b'.repeat(40)
    const claude = EMIT_FORMATS.find((f: any) => f.id === 'claude')
    const selOld = selectNotes({ corpusDir: dir, dateMap: {}, budgetBytes: 8192, style: 'md', commitHash: OLD, file: 'CLAUDE.md' })
    const blockOld = renderBlock({ format: claude, selection: selOld, commitHash: OLD, corpusDir: dir })
    const io = memIo({ [join('t', 'CLAUDE.md')]: blockOld + '\n' })

    // injected commitHash is DIFFERENT (HASH) — check must regenerate at OLD (from the anchor)
    const r = emitAll({ targetDir: 't', corpusDir: dir, commitHash: HASH, dateMap: {}, formats: [claude], check: true, io })
    expect(r.counts.drift).toBe(0)
    expect(io.stats.writes).toBe(0)
  })

  it('absent files are counted missing, never drift', () => {
    const io = memIo()
    const r = emitAll({ targetDir: 't', corpusDir: dir, commitHash: HASH, dateMap: {}, formats: EMIT_FORMATS, check: true, io })
    expect(r.counts.missing).toBe(4)
    expect(r.counts.drift).toBe(0)
    expect(io.stats.writes).toBe(0)
  })
})
