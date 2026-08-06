/**
 * Tests for scripts/sma/lib/generator.mjs.
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
 *     subsection first (CORE = blockers + current pointer + top facts).
 *
 * Determinism: the generator NEVER reads Date.now()/mtime/HEAD in the output path;
 * commitHash + dateMap are injected. Tests never shell out.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildIndex,
  buildAreaIndexes,
  CORE_THRESHOLD,
  CRITICALITY_WEIGHTS,
  GENERATED_MARKER,
  computeDateMap,
  isVisibleNow,
  projectNoteAxis,
} from '../lib/generator.mjs'
import { resolvePeriphery } from '../lib/loader.mjs'
import { runLint } from '../lib/lint.mjs'
import { ALWAYS_LOAD_BUDGET } from '../lib/constants.mjs'
import { serializeNote } from '../lib/frontmatter.mjs'
import { writeEpisode } from '../lib/episodes.mjs'

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

/** Write a schema-v2 record through the shared serializer (never hand-rolled). */
function v2note(dir: string, name: string, fm: Record<string, unknown>, body = 'body\n') {
  writeFileSync(join(dir, name), serializeNote({ frontmatter: fm, body, schemaVersion: 2 }), 'utf8')
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
    description: 'SMS is the primary customer channel not push',
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

  it('Test 3: CORE stays in MEMORY.md; every periphery note is ONE line in its area index (C1/B10)', () => {
    const out = buildIndex({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    // CORE notes are the two importance ≥ 9 facts — still always-loaded.
    expect(out).toContain('Email SEND blocked on prod by Railway SMTP ports')
    expect(out).toContain('Always run the full test suite before pushing to main')
    // Periphery lines LEFT MEMORY.md (the index thinning).
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

// ── Index restructure — thin discovery + per-area files ─────────────────────

describe('index restructure', () => {
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
      // The whole always-load payload fits the index budget.
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

// ── the schema-v2 corpus: status filter, context_priority, retrieval.areas ───

describe('generator.mjs — a corpus that speaks both schema versions', () => {
  /**
   * A mixed corpus: v1 notes carrying a lifecycle `status`, and v2 records whose
   * CORE membership is stated by `context_priority` and whose area membership is
   * stated by `retrieval.areas` (the v2 twin of v1 `tags`).
   */
  function mixedCorpus(): { dir: string; tags: string } {
    const dir = mkdtempSync(join(tmpdir(), 'sma-gen-v2-'))
    const tags = join(dir, 'TAGS.md')
    writeFileSync(tags, TAGS_MD, 'utf8')

    // v1, CORE-worthy by importance, but RETIRED — trust says it must not load.
    note(dir, 'retired.md', {
      description: 'The old deploy runbook everyone still quotes',
      kind: 'procedural-rule',
      tags: ['tech'],
      importance: 10,
      status: 'superseded',
    })
    // v1, CORE-worthy by importance, and REVOKED — same verdict, harder.
    note(dir, 'revoked.md', {
      description: 'A rule that turned out to be wrong and was withdrawn',
      kind: 'decision',
      tags: ['tech'],
      importance: 10,
      status: 'revoked',
    })
    // v1, CORE, alive — the control.
    note(dir, 'alive.md', {
      description: 'The current deploy runbook',
      kind: 'procedural-rule',
      tags: ['tech'],
      importance: 10,
      status: 'active',
    })

    // v2, always-load: no importance field exists in v2 at all.
    v2note(dir, 'v2-always.md', {
      id: 'v2-always',
      schema_version: '2',
      status: 'active',
      memory_type: 'normative',
      truth_mode: 'normative',
      claim: 'The suite runs twice before a release push',
      language: 'ru',
      context_priority: 'always',
      sensitivity: 'internal',
      retrieval: { areas: ['tech'] },
    })
    // v2, on-demand: catalogued, never always-loaded.
    v2note(dir, 'v2-ondemand.md', {
      id: 'v2-ondemand',
      schema_version: '2',
      status: 'active',
      memory_type: 'semantic',
      truth_mode: 'factual',
      claim: 'SMS remains the primary customer channel',
      language: 'ru',
      context_priority: 'on-demand',
      sensitivity: 'internal',
      retrieval: { areas: ['messaging'] },
    })
    // v2, always-load BUT revoked — the status filter outranks the priority.
    v2note(dir, 'v2-revoked.md', {
      id: 'v2-revoked',
      schema_version: '2',
      status: 'revoked',
      memory_type: 'normative',
      truth_mode: 'normative',
      claim: 'A withdrawn rule that still asks to be always-loaded',
      language: 'ru',
      context_priority: 'always',
      sensitivity: 'internal',
      retrieval: { areas: ['tech'] },
    })
    return { dir, tags }
  }

  it('a superseded or revoked note NEVER reaches CORE — whatever its importance says', () => {
    const { dir, tags } = mixedCorpus()
    try {
      const out = buildIndex({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })
      expect(out).toContain('(alive.md)') // the control loads
      expect(out).not.toContain('(retired.md)')
      expect(out).not.toContain('(revoked.md)')
      // Not deleted — demoted: still catalogued, and marked for what it is.
      const all = buildAreaIndexes({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })
        .map((a: { content: string }) => a.content)
        .join('\n')
      const line = (name: string) => all.split('\n').find((l) => l.includes(`(${name})`))!
      expect(line('retired.md')).toContain('status: superseded')
      expect(line('revoked.md')).toContain('status: revoked')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('a v2 record joins CORE by context_priority — and a revoked one still cannot', () => {
    const { dir, tags } = mixedCorpus()
    try {
      const out = buildIndex({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })
      expect(out).toContain('(v2-always.md)')
      expect(out).toContain('The suite runs twice before a release push') // the claim renders
      expect(out).not.toContain('(v2-ondemand.md)')
      expect(out).not.toContain('(v2-revoked.md)')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('v2 retrieval.areas feeds the area indexes exactly as v1 tags do (1:1)', () => {
    const { dir, tags } = mixedCorpus()
    try {
      const areas = buildAreaIndexes({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })
      const byFile = new Map(areas.map((a: { file: string; content: string }) => [a.file, a.content]))
      // retrieval.areas: [messaging] lands in the messaging index and nowhere else.
      expect(byFile.get('INDEX-messaging.md')).toContain('(v2-ondemand.md)')
      expect(byFile.get('INDEX-tech.md') ?? '').not.toContain('(v2-ondemand.md)')
      // A registered area is never the misc fallback.
      expect(byFile.has('INDEX-misc.md')).toBe(false)
      // The index line carries the v2 record's own vocabulary.
      const line = byFile.get('INDEX-messaging.md')!.split('\n').find((l) => l.includes('(v2-ondemand.md)'))!
      expect(line).toContain('semantic')
      expect(line).toContain('messaging')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('an episode under episodes/ leaves the generated bytes IDENTICAL (invisible by directory)', () => {
    const { dir, tags } = mixedCorpus()
    try {
      const build = () => buildIndex({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} })
      const buildAreas = () =>
        JSON.stringify(buildAreaIndexes({ corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} }))
      const indexBefore = build()
      const areasBefore = buildAreas()

      const written = writeEpisode({
        corpusDir: dir,
        id: 'episode-release-night',
        frontmatter: {
          status: 'archived',
          recorded_at: '2026-07-22',
          observed_at: '2026-07-21',
          sensitivity: 'internal',
          language: 'ru',
        },
        body: '\nMany claims live here, and none of them reach the default load.\n',
      })
      expect(written.created).toBe(true)

      // Positive byte-identity: the episode exists on disk and changed nothing.
      expect(build()).toBe(indexBefore)
      expect(buildAreas()).toBe(areasBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('stays byte-deterministic across runs on the mixed corpus (no clock, no locale, no machine identity)', () => {
    const { dir, tags } = mixedCorpus()
    try {
      const opts = { corpusDir: dir, tagsPath: tags, commitHash: HASH, dateMap: {} }
      expect(buildIndex(opts)).toBe(buildIndex(opts))
      expect(JSON.stringify(buildAreaIndexes(opts))).toBe(JSON.stringify(buildAreaIndexes(opts)))
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

describe('generator.mjs — corpus without TAGS.md (fail-soft registry)', () => {
  it('buildIndex + buildAreaIndexes succeed with an absent registry: every periphery note lands in misc', () => {
    rmSync(tagsPath, { force: true })

    const generated = buildIndex({ corpusDir, tagsPath, commitHash: HASH, dateMap })
    // The index is a complete GENERATED artifact — no crash, CORE intact.
    expect(generated).toContain('GENERATED')
    expect(generated).toContain('(blocker.md)')
    // With no registered areas the whole periphery is catalogued under misc.
    expect(generated).toContain('INDEX-misc.md')

    const areas = buildAreaIndexes({ corpusDir, tagsPath, commitHash: HASH, dateMap })
    expect(areas.map((a) => a.file)).toEqual(['INDEX-misc.md'])
    // A periphery note is still a discoverable index line (misc bucket).
    expect(areas[0].content).toContain('(bbb.md)')
  })
})

/**
 * Read-time hard filters (retrieval accuracy work): the visibility predicate the
 * loader runs BEFORE any ranking. `docs/MEMORY-MODEL.md` §9.1 states the contract —
 * permission/sensitivity/status/valid time/scope decided before ranking — and only
 * the `status` half of it was executed by code. These tests pin the other halves.
 *
 * The predicate answers ONE question: «may this record be shown right now, to this
 * consumer». It is deliberately NOT the write-time approval ladder (that answers
 * «may this record exist»); the two read the same fields and must not be merged.
 */
describe('generator.mjs — isVisibleNow (read-time hard filter, §9.1)', () => {
  const NOW = '2026-08-02T12:00:00Z'

  /** A projected v2 record — the same axis the loader and the index read. */
  const rec = (fm: Record<string, unknown>) =>
    projectNoteAxis(
      { id: 'n', schema_version: 2, status: 'active', memory_type: 'semantic', truth_mode: 'factual', claim: 'c', ...fm },
      { file: 'n.md', schemaVersion: 2 },
    )

  it('Test 1: a superseded or revoked record is not visible; an active one is (status, regression)', () => {
    expect(isVisibleNow(rec({ status: 'superseded' }), { now: NOW })).toBe(false)
    expect(isVisibleNow(rec({ status: 'revoked' }), { now: NOW })).toBe(false)
    expect(isVisibleNow(rec({ status: 'active' }), { now: NOW })).toBe(true)
    // A v1 note carries no status at all — absence is never a reason to hide.
    expect(isVisibleNow(projectNoteAxis({ description: 'd', importance: 5 }, { file: 'v1.md' }), { now: NOW })).toBe(true)
  })

  it('Test 2: valid_until in the past hides the record; in the future keeps it; absent imposes nothing', () => {
    expect(isVisibleNow(rec({ valid_until: '2026-07-01' }), { now: NOW })).toBe(false)
    expect(isVisibleNow(rec({ valid_until: '2026-08-18' }), { now: NOW })).toBe(true)
    expect(isVisibleNow(rec({}), { now: NOW })).toBe(true)
    // The day named in valid_until is still inside the validity window (conservative
    // reading of a date-only stamp: valid THROUGH that day, not until its midnight).
    expect(isVisibleNow(rec({ valid_until: '2026-08-02' }), { now: NOW })).toBe(true)
    // The other end of the same axis: a record not yet in force is not visible either.
    expect(isVisibleNow(rec({ valid_from: '2026-09-01' }), { now: NOW })).toBe(false)
    expect(isVisibleNow(rec({ valid_from: '2026-07-01' }), { now: NOW })).toBe(true)
    // `now` is injected for determinism; the same record answers the same way twice.
    expect(isVisibleNow(rec({ valid_until: '2026-07-01' }), { now: new Date(NOW) })).toBe(false)
    // A malformed stamp is a schema finding for the lint, never a silent hide.
    expect(isVisibleNow(rec({ valid_until: 'вчера' }), { now: NOW })).toBe(true)
  })

  it('Test 3: sensitivity filters by audience only — the local owner default keeps everything', () => {
    const sensitive = rec({ sensitivity: 'sensitive' })
    const internal = rec({ sensitivity: 'internal' })
    const pub = rec({ sensitivity: 'public' })

    // Default audience = the local owner: nothing is withheld (filtering here would
    // cost recall on one's own corpus without protecting anything).
    expect(isVisibleNow(sensitive, { now: NOW })).toBe(true)
    expect(isVisibleNow(rec({ sensitivity: 'encrypted-required' }), { now: NOW })).toBe(true)

    // A lower-class consumer: a record above its ceiling is not visible.
    expect(isVisibleNow(sensitive, { now: NOW, audience: 'subagent' })).toBe(false)
    expect(isVisibleNow(internal, { now: NOW, audience: 'subagent' })).toBe(true)
    expect(isVisibleNow(internal, { now: NOW, audience: 'export' })).toBe(false)
    expect(isVisibleNow(pub, { now: NOW, audience: 'export' })).toBe(true)
    // An audience named as a sensitivity class reads as that ceiling.
    expect(isVisibleNow(sensitive, { now: NOW, audience: 'internal' })).toBe(false)
    // An unknown audience is fail-closed to the narrowest ceiling, never fail-open.
    expect(isVisibleNow(internal, { now: NOW, audience: 'whoever' })).toBe(false)
    expect(isVisibleNow(pub, { now: NOW, audience: 'whoever' })).toBe(true)
  })

  it('Test 5: the index is a map, not a payload — buildIndex/buildAreaIndexes never drop an expired record', () => {
    v2note(corpusDir, 'v2-expired.md', {
      id: 'v2-expired',
      schema_version: '2',
      status: 'active',
      memory_type: 'semantic',
      truth_mode: 'factual',
      claim: 'A waiver that stopped being true in July',
      language: 'ru',
      valid_until: '2026-07-01',
      context_priority: 'on-demand',
      sensitivity: 'internal',
      retrieval: { areas: ['memory'] },
    })

    const generated = buildIndex({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    const areas = buildAreaIndexes({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    const memoryIndex = areas.find((a) => a.file === 'INDEX-memory.md')

    // Catalogued and findable — the record is out of the delivery, not out of the corpus.
    expect(memoryIndex?.content).toContain('(v2-expired.md)')
    expect(generated).toContain('GENERATED')
  })
})

describe('generator.mjs — criticality carries the weight of a migrated record (one axis)', () => {
  /** A projected v2 record — the same axis the index, the loader and the reflex read. */
  const v2 = (fm: Record<string, unknown>) =>
    projectNoteAxis(
      {
        id: 'n',
        schema_version: 2,
        status: 'active',
        memory_type: 'procedural',
        truth_mode: 'factual',
        claim: 'c',
        ...fm,
      },
      { file: 'n.md', schemaVersion: 2 },
    )

  it('Test 1: an on-demand v2 record weighs its criticality, never zero', () => {
    // The approved semantics, spelled out by number: a silent redefinition of the
    // grades has to fail HERE, not downstream in someone's reflex going quiet.
    expect({ ...CRITICALITY_WEIGHTS }).toEqual({ low: 2, medium: 5, high: 8, critical: 8 })

    expect(v2({ context_priority: 'on-demand', criticality: 'high' }).weight).toBe(8)
    expect(v2({ context_priority: 'on-demand', criticality: 'medium' }).weight).toBe(5)
    expect(v2({ context_priority: 'on-demand', criticality: 'low' }).weight).toBe(2)
    // The severest grade of the documented ladder is never quieter than `high`.
    expect(v2({ context_priority: 'on-demand', criticality: 'critical' }).weight).toBeGreaterThanOrEqual(
      CRITICALITY_WEIGHTS.high,
    )
    // Written loudly or oddly spaced, a grade is still that grade.
    expect(v2({ context_priority: 'on-demand', criticality: ' High ' }).weight).toBe(8)
    // A record stating no grade at all stays exactly where it always was.
    expect(v2({ context_priority: 'on-demand' }).weight).toBe(0)
    // …and so does a word outside the documented ladder (no invented tiers).
    expect(v2({ context_priority: 'on-demand', criticality: 'urgent' }).weight).toBe(0)
  })

  it('Test 2: context_priority always still outranks the grade (CORE floor kept)', () => {
    expect(v2({ context_priority: 'always', criticality: 'medium' }).weight).toBe(CORE_THRESHOLD)
    expect(v2({ context_priority: 'always', criticality: 'high' }).weight).toBe(CORE_THRESHOLD)
    expect(v2({ context_priority: 'always' }).weight).toBe(CORE_THRESHOLD)
  })

  it('Test 3: an explicit importance stays primary — the grade never overrides a stated number', () => {
    // A v1 note that states 4 weighs 4, whatever a stray criticality key says.
    expect(projectNoteAxis({ description: 'd', importance: 4, criticality: 'high' }, { file: 'v1.md' }).weight).toBe(4)
    // A stated zero is a statement too, not an absence to be filled in.
    expect(projectNoteAxis({ description: 'd', importance: 0, criticality: 'high' }, { file: 'v1.md' }).weight).toBe(0)
    // The v1 law itself is untouched: number in, number out, CORE floor for `always`.
    expect(projectNoteAxis({ description: 'd', importance: 10 }, { file: 'v1.md' }).weight).toBe(10)
    // The `importance` slot of the axis keeps telling the truth: v2 states no number.
    expect(v2({ context_priority: 'on-demand', criticality: 'high' }).importance).toBe(0)
  })

  it('Test 4: the grade reaches the delivery path — a graded record sorts ahead of an ungraded one', () => {
    v2note(corpusDir, 'v2-zeta-graded.md', {
      id: 'v2-zeta-graded',
      schema_version: '2',
      status: 'active',
      memory_type: 'procedural',
      truth_mode: 'factual',
      claim: 'A migrated lesson that states how much missing it costs',
      language: 'ru',
      criticality: 'high',
      context_priority: 'on-demand',
      sensitivity: 'internal',
      retrieval: { areas: ['memory'] },
    })
    v2note(corpusDir, 'v2-alpha-ungraded.md', {
      id: 'v2-alpha-ungraded',
      schema_version: '2',
      status: 'active',
      memory_type: 'semantic',
      truth_mode: 'factual',
      claim: 'A migrated record that states no grade at all',
      language: 'ru',
      context_priority: 'on-demand',
      sensitivity: 'internal',
      retrieval: { areas: ['memory'] },
    })

    const areas = buildAreaIndexes({ corpusDir, tagsPath, commitHash: HASH, dateMap, coreThreshold: 9 })
    const memoryIndex = areas.find((a) => a.file === 'INDEX-memory.md')?.content ?? ''
    const graded = memoryIndex.indexOf('(v2-zeta-graded.md)')
    const ungraded = memoryIndex.indexOf('(v2-alpha-ungraded.md)')

    expect(graded).toBeGreaterThanOrEqual(0)
    expect(ungraded).toBeGreaterThanOrEqual(0)
    // Weight-desc is the first key of the comparator: the graded record leads.
    expect(graded).toBeLessThan(ungraded)
  })
})
