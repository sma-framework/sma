/**
 * Tests for scripts/sma/lib/citations.mjs + the loader's load-citation wiring
 * (Phase 49.1 Plan 11, Task 1 — B4 usage journal).
 *
 *   - Test 1: recordCitation({noteId, kind, terminal}) appends ONE JSONL line to
 *     .sma/usage/<terminal>.jsonl (temp DI dir); seq increments per terminal file.
 *   - Test 2: usageStats over a fixture ledger returns per-note counts split by
 *     kind ('load' vs 'fire') with lastCitedAt; reflex journal entries (49.1-10,
 *     type 'reflex') fold in as fire-citations — one usage model over both.
 *   - Test 3: deadWeight({sessions: N}) lists corpus notes with ZERO citations
 *     across the last N sessions; a cited note is excluded.
 *   - Test 4: loader.resolvePeriphery with citation wiring records one 'load'
 *     citation per returned note; the returned set is UNCHANGED vs the unwired call.
 *   - Test 5: a citation write failure never breaks the load (fail-open) —
 *     a throwing cite callback and an unwritable usage dir are both survivable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordCitation, usageStats, deadWeight } from '../lib/citations.mjs'
import { resolvePeriphery } from '../lib/loader.mjs'
import { appendEvent } from '../lib/journal.mjs'
import { resolveTerminalIdentity } from '../lib/registry.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')

const TAGS_MD = `# TAGS

## area
- tech — infra, build, migrations. · aliases: infra
- memory — memory system: notes, index. · aliases: sma, notes

## kind
- procedural-rule — a how-to rule. · aliases: rule
- reference — a lookup fact.
- bug-lesson — a lesson from a bug. · aliases: lesson

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

let tmp: string
let usageDir: string
let journalDir: string
let corpusDir: string
let tagsPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sma-cit-'))
  usageDir = join(tmp, 'usage')
  journalDir = join(tmp, 'journal')
  corpusDir = join(tmp, 'corpus')
  mkdirSync(corpusDir, { recursive: true })
  tagsPath = join(corpusDir, 'TAGS.md')
  writeFileSync(tagsPath, TAGS_MD, 'utf8')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('citations.mjs — recordCitation (B4 append-only ledger)', () => {
  it('Test 1: appends one JSONL line per citation to <terminal>.jsonl, seq increments', () => {
    const first = recordCitation({ noteId: 'a.md', kind: 'load', terminal: 'term-1' }, { usageDir })
    expect(first).not.toBeNull()

    const file = join(usageDir, 'term-1.jsonl')
    let lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    const rec = JSON.parse(lines[0])
    expect(rec.noteId).toBe('a.md')
    expect(rec.kind).toBe('load')
    expect(rec.terminal).toBe('term-1')
    expect(rec.seq).toBe(1)
    expect(typeof rec.ts).toBe('string')

    recordCitation({ noteId: 'b.md', kind: 'fire', terminal: 'term-1' }, { usageDir })
    lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[1]).seq).toBe(2)
    expect(JSON.parse(lines[1]).kind).toBe('fire')
  })
})

describe('citations.mjs — usageStats (per-note counts, reflex fires folded)', () => {
  it('Test 2: per-note counts split by kind with lastCitedAt; journal reflex entries count as fires', () => {
    recordCitation(
      { noteId: 'a.md', kind: 'load', terminal: 'term-1' },
      { usageDir, now: '2026-07-01T00:00:00.000Z' },
    )
    recordCitation(
      { noteId: 'a.md', kind: 'load', terminal: 'term-1' },
      { usageDir, now: '2026-07-02T00:00:00.000Z' },
    )
    recordCitation(
      { noteId: 'b.md', kind: 'load', terminal: 'term-2' },
      { usageDir, now: '2026-07-01T12:00:00.000Z' },
    )
    // A reflex fire journaled by 49.1-10's consumer — folds in as a fire-citation.
    appendEvent(
      { type: 'reflex', scope: 'src/x.ts', detail: { noteId: 'b.md', target: 'src/x.ts', tier: 'warn' } },
      { terminalId: 'term-2', journalDir, now: '2026-07-03T00:00:00.000Z' },
    )
    // A non-reflex journal event must NOT count.
    appendEvent(
      { type: 'claim', scope: 'x', detail: {} },
      { terminalId: 'term-2', journalDir, now: '2026-07-03T01:00:00.000Z' },
    )

    const { notes } = usageStats({ usageDir, journalDir })
    const a = notes.find((n: any) => n.noteId === 'a.md')
    const b = notes.find((n: any) => n.noteId === 'b.md')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a.load).toBe(2)
    expect(a.fire).toBe(0)
    expect(a.total).toBe(2)
    expect(a.lastCitedAt).toBe('2026-07-02T00:00:00.000Z')
    expect(b.load).toBe(1)
    expect(b.fire).toBe(1)
    expect(b.total).toBe(2)
    expect(b.lastCitedAt).toBe('2026-07-03T00:00:00.000Z')
  })
})

describe('citations.mjs — deadWeight (FI-9 demotion data source)', () => {
  it('Test 3: zero-citation notes across the last N sessions listed; a cited note excluded', () => {
    // Corpus: three notes + a structural file that must never appear as dead weight.
    note(corpusDir, 'a.md', { description: 'A', kind: 'reference', tags: ['tech'], 'use-when': 'x', importance: 5 })
    note(corpusDir, 'b.md', { description: 'B', kind: 'reference', tags: ['tech'], 'use-when': 'x', importance: 5 })
    note(corpusDir, 'c.md', { description: 'C', kind: 'reference', tags: ['tech'], 'use-when': 'x', importance: 5 })
    writeFileSync(join(corpusDir, 'MEMORY.md'), '# index\n', 'utf8')

    // Session s2 (older) cited b.md; session s1 (newer) cited a.md.
    recordCitation(
      { noteId: 'b.md', kind: 'load', terminal: 'term-1', session: 's2' },
      { usageDir, now: '2026-07-01T00:00:00.000Z' },
    )
    recordCitation(
      { noteId: 'a.md', kind: 'load', terminal: 'term-1', session: 's1' },
      { usageDir, now: '2026-07-02T00:00:00.000Z' },
    )

    // Last 1 session (s1): only a.md is cited — b.md and c.md are dead weight.
    const last1 = deadWeight({ usageDir, journalDir, corpusDir, sessions: 1 })
    expect(last1.dead).toEqual(['b.md', 'c.md'])
    expect(last1.dead).not.toContain('a.md') // the cited note is excluded
    expect(last1.sessionsConsidered).toBe(1)

    // Last 2 sessions (s1 + s2): only c.md remains dead.
    const last2 = deadWeight({ usageDir, journalDir, corpusDir, sessions: 2 })
    expect(last2.dead).toEqual(['c.md'])
    expect(last2.sessionsConsidered).toBe(2)
  })
})

describe('loader.mjs — citation wiring (one usage model over load + fire)', () => {
  beforeEach(() => {
    note(corpusDir, 'core1.md', { description: 'CORE fact', kind: 'status', tags: ['tech'], 'use-when': 'always', importance: 10 })
    note(corpusDir, 'tech-rule.md', { description: 'tech rule', kind: 'procedural-rule', tags: ['tech'], 'use-when': 'building', importance: 6 })
    note(corpusDir, 'mem-ref.md', { description: 'memory ref', kind: 'reference', tags: ['memory'], 'use-when': 'memory work', importance: 5 })
  })

  it('Test 4: resolvePeriphery with cite wiring records one load citation per returned note; result unchanged', () => {
    const q = { tags: ['tech'], corpusDir, tagsPath, dateMap: {} }
    const base = resolvePeriphery(q)

    const cited: string[] = []
    const wired = resolvePeriphery({ ...q, cite: (f: string) => cited.push(f) })

    // Returned set is UNCHANGED by the wiring (additive-only instrumentation).
    expect(wired).toEqual(base)

    // One citation per returned note (CORE + periphery), none extra.
    const returned = [...base.core, ...base.periphery]
    expect([...cited].sort()).toEqual([...returned].sort())
    expect(cited.length).toBe(returned.length)
  })

  it('Test 5: a citation write failure never breaks the load (fail-open)', () => {
    // (a) a throwing cite callback is swallowed per note — the load still resolves.
    const res = resolvePeriphery({
      tags: ['tech'],
      corpusDir,
      tagsPath,
      dateMap: {},
      cite: () => {
        throw new Error('disk full')
      },
    })
    expect(res.core).toContain('core1.md')
    expect(res.periphery).toContain('tech-rule.md')

    // (b) recordCitation against an unwritable usage dir returns null, never throws.
    const blocker = join(tmp, 'blocker')
    writeFileSync(blocker, 'a file, not a dir', 'utf8')
    const out = recordCitation(
      { noteId: 'a.md', kind: 'load', terminal: 'term-1' },
      { usageDir: join(blocker, 'usage') },
    )
    expect(out).toBeNull()
  })
})

// ── Task 2/3: session-start pre-act injection + `sma usage` (real CLI) ────────

const TEST_ENV = {
  SMA_TERMINAL_NAME: 'exec',
  SMA_WINDOW_TOKEN: 'wtok-cit-1',
  SMA_DISABLE_SNAPSHOT_SPAWN: '1',
}

/** Run the real CLI against a temp .sma root (cli.test.ts pattern). */
function runCli(
  smaRoot: string,
  args: string[],
  stdin = '',
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, ...TEST_ENV, SMA_ROOT_OVERRIDE: smaRoot },
    })
    return { stdout, status: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout ?? '').toString(), status: typeof err.status === 'number' ? err.status : 1 }
  }
}

describe('cli.mjs session-start — budgeted pre-act injection (49.1-11 T2, B1)', () => {
  let root: string
  let smaRoot: string
  let realCorpus: string
  let terminalId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sma-preact-'))
    smaRoot = join(root, '.sma')
    mkdirSync(smaRoot, { recursive: true })
    realCorpus = join(root, '.claude', 'memory')
    mkdirSync(realCorpus, { recursive: true })
    writeFileSync(join(realCorpus, 'TAGS.md'), TAGS_MD, 'utf8')
    terminalId = resolveTerminalIdentity({ env: TEST_ENV as any }).terminalId
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** Seed this terminal's OWN session lease with a claimed scope. */
  function seedOwnClaim(description: string) {
    const dir = join(smaRoot, 'sessions')
    mkdirSync(dir, { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      join(dir, `${terminalId}.json`),
      JSON.stringify({
        holderIdentity: 'exec',
        pid: 1,
        scope: { globs: [], description },
        status: 'working',
        blockers: [],
        acquireTime: now,
        renewTime: now,
        leaseDurationSeconds: 1800,
        transitions: 1,
      }),
    )
  }

  it('injects trigger-matched periphery when a claim matches a seeded note; budget held; citations recorded', () => {
    // Periphery note matched by the claim's 'tech' token; importance >= 8 → extract.
    note(realCorpus, 'tech-hi.md', {
      description: 'A high-importance tech rule',
      kind: 'procedural-rule',
      tags: ['tech'],
      'use-when': 'building',
      importance: 8,
    }, 'intro\n\n**How to apply:** always run the targeted test first.\n\nmore\n')
    note(realCorpus, 'tech-rule.md', {
      description: 'A tech procedural rule',
      kind: 'procedural-rule',
      tags: ['tech'],
      'use-when': 'building',
      importance: 6,
    })
    // Unrelated note must NOT be injected.
    note(realCorpus, 'mem-ref.md', {
      description: 'A memory reference fact',
      kind: 'reference',
      tags: ['memory'],
      'use-when': 'memory work',
      importance: 6,
    })
    seedOwnClaim('tech work')

    const { stdout, status } = runCli(smaRoot, ['session-start'], '{}')
    expect(status).toBe(0)
    const out = JSON.parse(stdout.trim())
    const ctx: string = out.hookSpecificOutput.additionalContext
    const idx = ctx.indexOf('Релевантная память (pre-act):')
    expect(idx).toBeGreaterThan(-1)
    const section = ctx.slice(idx)
    expect(section).toContain('tech-hi.md')
    expect(section).toContain('tech-rule.md')
    expect(section).not.toContain('mem-ref.md')
    expect(section).toContain('Применение:') // How-to-apply extract for importance >= 8
    expect(Buffer.byteLength(section, 'utf8')).toBeLessThanOrEqual(2048)

    // B4: each injected note recorded as a 'load' citation in .sma/usage/.
    const ledger = join(smaRoot, 'usage', `${terminalId}.jsonl`)
    expect(existsSync(ledger)).toBe(true)
    const recs = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const notes = recs.map((r) => r.noteId).sort()
    expect(notes).toContain('tech-hi.md')
    expect(notes).toContain('tech-rule.md')
    expect(recs.every((r) => r.kind === 'load')).toBe(true)
  })

  it('holds the 2048-byte budget under a flood of matching notes', () => {
    for (let i = 0; i < 40; i++) {
      note(realCorpus, `tech-note-${String(i).padStart(2, '0')}.md`, {
        description: `A long tech note ${i} — ${'x'.repeat(140)}`,
        kind: 'procedural-rule',
        tags: ['tech'],
        'use-when': 'building',
        importance: 6,
      })
    }
    seedOwnClaim('tech work')

    const { stdout, status } = runCli(smaRoot, ['session-start'], '{}')
    expect(status).toBe(0)
    const ctx: string = JSON.parse(stdout.trim()).hookSpecificOutput.additionalContext
    const idx = ctx.indexOf('Релевантная память (pre-act):')
    expect(idx).toBeGreaterThan(-1)
    expect(Buffer.byteLength(ctx.slice(idx), 'utf8')).toBeLessThanOrEqual(2048)
  })

  it('fail-open: empty stdin, no claim, no corpus — still exit 0', () => {
    rmSync(realCorpus, { recursive: true, force: true })
    const { status } = runCli(smaRoot, ['session-start'], '')
    expect(status).toBe(0)
  })
})

describe('cli.mjs usage — B4 report (49.1-11 T3)', () => {
  let root: string
  let smaRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sma-usage-'))
    smaRoot = join(root, '.sma')
    mkdirSync(smaRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('usage --json is valid JSON on an EMPTY ledger (honest empty state)', () => {
    const { stdout, status } = runCli(smaRoot, ['usage', '--json'])
    expect(status).toBe(0)
    const out = JSON.parse(stdout.trim())
    expect(out.notes).toEqual([])
  })

  it('usage --dead-weight lists uncited corpus notes; cited notes excluded', () => {
    const corpus = join(root, 'corpus')
    mkdirSync(corpus, { recursive: true })
    writeFileSync(join(corpus, 'TAGS.md'), TAGS_MD, 'utf8')
    note(corpus, 'used.md', { description: 'used', kind: 'reference', tags: ['tech'], 'use-when': 'x', importance: 5 })
    note(corpus, 'dead.md', { description: 'dead', kind: 'reference', tags: ['tech'], 'use-when': 'x', importance: 5 })
    recordCitation(
      { noteId: 'used.md', kind: 'load', terminal: 'term-1', session: 's1' },
      { usageDir: join(smaRoot, 'usage') },
    )

    const { stdout, status } = runCli(smaRoot, ['usage', '--dead-weight', '--json', '--corpus', corpus, '--sessions', '5'])
    expect(status).toBe(0)
    const out = JSON.parse(stdout.trim())
    expect(out.deadWeight).toEqual(['dead.md'])
    expect(out.deadWeight).not.toContain('used.md')
    const used = out.notes.find((n: any) => n.noteId === 'used.md')
    expect(used.load).toBe(1)
  })
})
