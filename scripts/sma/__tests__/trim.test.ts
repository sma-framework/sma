/**
 * Tests for scripts/sma/lib/trim.mjs (Phase 9.1 Plan 13, Task 2).
 *
 * FI-9 demotion-only trimmer — overflow moves DOWN a layer, nothing is ever
 * deleted ("система никогда ничего не забывает", founder lock):
 *   - Test 1: plan() (dry-run default) over an over-budget fixture CORE returns
 *     the demotion list ordered least-recently-cited-first and writes NOTHING.
 *   - Test 2: demoteCore with apply:true moves the selected CORE members to
 *     periphery status (bodies untouched, membership/importance changed) —
 *     total corpus file count UNCHANGED (nothing deleted).
 *   - Test 3: splitNote on a 9 KB fixture note produces the trimmed note + an
 *     archive note with a supersedes back-link; combined content preserves
 *     every original body line.
 *   - Test 4: trimState on an over-budget STATE fixture moves the overflow
 *     section to STATE-ARCHIVE.md verbatim (byte-level containment assert).
 *   - Test 5: a note with recent citations is NEVER selected while an uncited
 *     one exists (9.1-11 usage data decides WHAT demotes).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { plan, demoteCore, splitNote, trimState } from '../lib/trim.mjs'
import { CORE_THRESHOLD } from '../lib/generator.mjs'
import { NOTE_BUDGET, STATE_BUDGET } from '../lib/constants.mjs'
import { parseNote } from '../lib/frontmatter.mjs'

const TAGS_MD = `# TAGS

## area
- tech — infra, build, migrations.
- memory — memory system: notes, index, tags.

## kind
- reference — a lookup fact.
- status — current state.
- episodic — a session event.

## phase
- Open facet: phase:NN.
`

/** Write a CORE note (importance 9) with a fat description + use-when. */
function coreNote(dir: string, name: string) {
  const desc = `core fact ${name} ` + 'd'.repeat(180)
  const useWhen = 'w'.repeat(180)
  const text = [
    '---',
    `description: ${desc}`,
    'kind: reference',
    'tags: [tech]',
    `use-when: ${useWhen}`,
    `importance: ${CORE_THRESHOLD}`,
    '---',
    '',
    `body of ${name}`,
    '',
  ].join('\n')
  writeFileSync(join(dir, name), text, 'utf8')
}

/** Append one citation event to the fixture usage ledger. */
function cite(usageDir: string, noteId: string, ts: string, seq: number) {
  const file = join(usageDir, 't-fixture.jsonl')
  const rec = { ts, terminal: 't-fixture', seq, noteId, kind: 'load', session: 's1' }
  writeFileSync(file, (safeRead(file) ?? '') + JSON.stringify(rec) + '\n', 'utf8')
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** Snapshot every file in a dir (name → content) for the writes-NOTHING assert. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(dir)) out[f] = readFileSync(join(dir, f), 'utf8')
  return out
}

let corpusDir: string
let tagsPath: string
let usageDir: string
let stateDir: string

// The 24 CORE notes: 6 uncited, 6 cited LONG AGO (2025), 12 cited recently.
const UNCITED = ['n00.md', 'n01.md', 'n02.md', 'n03.md', 'n04.md', 'n05.md']
const OLD_CITED = ['o00.md', 'o01.md', 'o02.md', 'o03.md', 'o04.md', 'o05.md']
const RECENT_CITED = [
  'r00.md', 'r01.md', 'r02.md', 'r03.md', 'r04.md', 'r05.md',
  'r06.md', 'r07.md', 'r08.md', 'r09.md', 'r10.md', 'r11.md',
]

beforeEach(() => {
  corpusDir = mkdtempSync(join(tmpdir(), 'sma-trim-'))
  usageDir = mkdtempSync(join(tmpdir(), 'sma-trim-usage-'))
  stateDir = mkdtempSync(join(tmpdir(), 'sma-trim-state-'))
  tagsPath = join(corpusDir, 'TAGS.md')
  writeFileSync(tagsPath, TAGS_MD, 'utf8')

  for (const n of [...UNCITED, ...OLD_CITED, ...RECENT_CITED]) coreNote(corpusDir, n)

  let seq = 1
  OLD_CITED.forEach((n, i) => cite(usageDir, n, `2025-01-0${i + 1}T00:00:00Z`, seq++))
  RECENT_CITED.forEach((n) => cite(usageDir, n, '2026-07-01T00:00:00Z', seq++))
})

afterEach(() => {
  for (const d of [corpusDir, usageDir, stateDir]) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

const trimOpts = () => ({ corpusDir, tagsPath, usageDir, journalDir: join(usageDir, 'no-journal') })

describe('trim.mjs — plan() dry-run (FI-9)', () => {
  it('Test 1: over-budget CORE → demotion list least-recently-cited-first; writes NOTHING', () => {
    const before = snapshot(corpusDir)
    const res = plan(trimOpts())

    const files = res.coreDemotions.map((d: { file: string }) => d.file)
    expect(files.length).toBeGreaterThanOrEqual(7) // overflow needs more than the uncited pool

    // Uncited notes demote FIRST (least-recently-cited = never cited), name asc.
    expect(files.slice(0, UNCITED.length)).toEqual([...UNCITED].sort())
    // Then the long-ago-cited ones, oldest citation first.
    const rest = files.slice(UNCITED.length)
    expect(rest.length).toBeGreaterThanOrEqual(1)
    for (const f of rest) expect(OLD_CITED).toContain(f)
    const restIdx = rest.map((f: string) => OLD_CITED.indexOf(f))
    expect([...restIdx].sort((a, b) => a - b)).toEqual(restIdx) // ascending ts order

    // Dry-run wrote NOTHING: byte-identical corpus.
    expect(snapshot(corpusDir)).toEqual(before)
  })

  it('Test 5: a recently-cited note is NEVER selected while an uncited one exists', () => {
    const res = plan(trimOpts())
    const files = res.coreDemotions.map((d: { file: string }) => d.file)
    for (const f of RECENT_CITED) expect(files).not.toContain(f)
    for (const f of UNCITED) expect(files).toContain(f)
  })
})

describe('trim.mjs — demoteCore apply (demotion, never deletion)', () => {
  it('Test 2: apply moves selected CORE members to periphery; file count unchanged; bodies untouched', () => {
    const before = snapshot(corpusDir)
    const countBefore = readdirSync(corpusDir).length

    const res = demoteCore({ ...trimOpts(), apply: true })
    expect(res.applied).toBe(true)
    expect(res.demoted.length).toBeGreaterThanOrEqual(7)

    // NOTHING deleted: same file count, every prior file still on disk.
    expect(readdirSync(corpusDir).length).toBe(countBefore)
    for (const f of Object.keys(before)) expect(safeRead(join(corpusDir, f))).not.toBeNull()

    for (const f of res.demoted) {
      const { frontmatter, body } = parseNote(readFileSync(join(corpusDir, f), 'utf8'), { file: f })
      // Membership changed: importance now below the CORE threshold.
      expect(Number(frontmatter!.importance)).toBeLessThan(CORE_THRESHOLD)
      // Body untouched (content preservation — FI-9).
      const orig = parseNote(before[f], { file: f })
      expect(body).toBe(orig.body)
      expect(frontmatter!.description).toBe(orig.frontmatter!.description)
    }

    // Non-demoted notes are byte-identical.
    for (const f of Object.keys(before)) {
      if ((res.demoted as string[]).includes(f)) continue
      expect(readFileSync(join(corpusDir, f), 'utf8')).toBe(before[f])
    }
  })
})

describe('trim.mjs — splitNote (episodic tail → archive note)', () => {
  it('Test 3: 9 KB note → trimmed note + archive with supersedes back-link; every original line preserved', () => {
    const name = 'project_big_history.md'
    const head = [
      '---',
      'description: a long project history note of many words',
      'kind: status',
      'tags: [memory]',
      'use-when: reading the full project history',
      'importance: 5',
      '---',
      '',
    ].join('\n')
    const bodyLines: string[] = []
    for (let i = 0; bodyLines.join('\n').length < 9 * 1024 - head.length; i++) {
      bodyLines.push(`line-${String(i).padStart(4, '0')} ` + 'h'.repeat(40))
    }
    const originalBody = bodyLines.join('\n') + '\n'
    writeFileSync(join(corpusDir, name), head + originalBody, 'utf8')

    const res = splitNote({ corpusDir, file: name, apply: true })
    expect(res.split).toBe(true)
    expect(res.applied).toBe(true)

    const trimmed = readFileSync(join(corpusDir, name), 'utf8')
    expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(NOTE_BUDGET)

    // The archive note exists and carries the supersedes back-link (FI-9).
    const archiveText = readFileSync(join(corpusDir, res.archiveFile), 'utf8')
    const archive = parseNote(archiveText, { file: res.archiveFile })
    expect(archive.frontmatter!.supersedes).toBe(name)

    // Combined content preserves EVERY original body line (nothing lost).
    const combined = new Set([...trimmed.split('\n'), ...archiveText.split('\n')])
    for (const line of bodyLines) expect(combined.has(line)).toBe(true)
  })
})

describe('trim.mjs — trimState (STATE.md overflow → STATE-ARCHIVE.md)', () => {
  it('Test 4: over-budget STATE → overflow sections land in STATE-ARCHIVE.md verbatim; protected sections stay', () => {
    const statePath = join(stateDir, 'STATE.md')
    const pad = (n: number) => ('p'.repeat(120) + '\n').repeat(n)
    const stateText = [
      '# STATE',
      '',
      '## Current Position',
      '',
      'Phase 9.1 — plan 13 executing.',
      '',
      '## Open Blockers',
      '',
      '- none',
      '',
      '## История секция A',
      '',
      pad(60),
      '## История секция B',
      '',
      pad(120),
      '## История секция C',
      '',
      pad(240),
    ].join('\n')
    expect(Buffer.byteLength(stateText, 'utf8')).toBeGreaterThan(STATE_BUDGET)
    writeFileSync(statePath, stateText, 'utf8')

    const res = trimState({ statePath, apply: true })
    expect(res.trimmed).toBe(true)

    const after = readFileSync(statePath, 'utf8')
    expect(Buffer.byteLength(after, 'utf8')).toBeLessThanOrEqual(STATE_BUDGET)
    // Protected sections never move.
    expect(after).toContain('## Current Position')
    expect(after).toContain('## Open Blockers')

    // Byte-level containment: every moved section appears VERBATIM in the archive.
    const archiveText = readFileSync(join(stateDir, 'STATE-ARCHIVE.md'), 'utf8')
    expect(res.movedChunks.length).toBeGreaterThanOrEqual(1)
    for (const chunk of res.movedChunks as string[]) {
      expect(chunk.length).toBeGreaterThan(0)
      expect(archiveText.includes(chunk)).toBe(true)
      expect(stateText.includes(chunk)).toBe(true) // the chunk IS original bytes
      expect(after.includes(chunk)).toBe(false) // and left STATE.md
    }
  })
})
