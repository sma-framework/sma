/**
 * Tests for scripts/sma/lib/memory-explain.mjs — the REASON TRACE of retrieval.
 *
 * A retrieval layer that cannot say why it withheld a record is a layer nobody can
 * debug and nobody should trust with a budget. This module answers, for EVERY note in
 * the corpus, exactly one question: did you arrive, and on what grounds — or were you
 * dropped, and by which filter.
 *
 * THE ONE PROPERTY THAT MAKES THE ANSWER WORTH ANYTHING: it explains the REAL
 * selection. The verdicts come from a trace collector threaded through the actual
 * compilePack / resolvePeriphery path, never from a second implementation that would
 * describe a retrieval nobody runs.
 *
 *   - Test 1 (accounting): selected ∪ rejected covers every note in the corpus, each
 *     note appears exactly once, and `unaccounted` is empty.
 *   - Test 2 (rejection names the filter and the field): a retired record, an expired
 *     one, one withheld by sensitivity, one with no tag overlap and one cut by the
 *     budget each carry their OWN reason code plus the field that decided it.
 *   - Test 3 (selection names its grounds): the CORE rule a record states about itself,
 *     the weight that carried it over the CORE floor, and a tag intersection are three
 *     different bases, not one word.
 *   - Test 4 (the trace changes nothing): the selected set is exactly the note set the
 *     untraced compilePack delivers, and a traced compile produces byte-identical pack
 *     bytes — instrumentation that moved the decision would be measuring itself.
 *   - Test 5 (the verb): `memory explain --task` is scriptable through --stat, and
 *     without a task it refuses with the syntax instead of explaining nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { explainRetrieval, EXPLAIN_REASONS } from '../lib/memory-explain.mjs'
import { compilePack } from '../lib/context-pack.mjs'

const EMDASH = String.fromCharCode(0x2014)

const TAGS =
  `## area\n- crm ${EMDASH} customer relationship\n- auth ${EMDASH} authentication\n\n` +
  `## kind\n- reference ${EMDASH} a fact\n- decision ${EMDASH} a decision\n`

/** The instant every test reads the corpus at — a measurement must not depend on today. */
const NOW = '2026-08-03T00:00:00Z'

let dir: string
let corpusDir: string

function writeNote(file: string, fields: Record<string, string>) {
  const fm = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', 'body']
  writeFileSync(join(corpusDir, file), fm.join('\n') + '\n', 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-memory-explain-'))
  corpusDir = join(dir, 'memory')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(join(corpusDir, 'TAGS.md'), TAGS, 'utf8')
  writeFileSync(join(corpusDir, 'MEMORY.md'), '# index\n- a core line\n', 'utf8')

  // states its own always-load rule (v2 grammar) -> basis: the CORE rule
  writeNote('always-rule.md', { description: 'the record that says it always loads', kind: 'reference', tags: '[crm]', context_priority: 'always' })
  // carried over the CORE floor by its number -> basis: weight
  writeNote('heavy-rule.md', { description: 'the heavy rule', kind: 'reference', tags: '[crm]', importance: '9' })
  // ordinary periphery, arrives on the tag intersection
  writeNote('crm-detail.md', { description: 'a crm periphery note', kind: 'reference', tags: '[crm]', importance: '5' })
  // names an area the task never does
  writeNote('auth-detail.md', { description: 'an auth note a crm task never names', kind: 'reference', tags: '[auth]', importance: '3' })
  // known to be wrong
  writeNote('retired-rule.md', { description: 'the rule that was replaced', kind: 'reference', tags: '[crm]', importance: '5', status: 'superseded' })
  // its own validity window closed before NOW
  writeNote('expired-rule.md', { description: 'the rule that ran out', kind: 'reference', tags: '[crm]', importance: '5', valid_until: '2026-01-01' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const opts = () => ({ task: 'fix the crm handler', corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), now: NOW, commit: 'c' })

describe('every note in the corpus gets exactly one verdict (Test 1)', () => {
  it('selected ∪ rejected covers the corpus, with nothing counted twice and nothing unaccounted', () => {
    const r = explainRetrieval(opts())

    const ids = [...r.selected.map((s: any) => s.id), ...r.rejected.map((x: any) => x.id)].sort()
    expect(ids).toEqual([
      'always-rule.md',
      'auth-detail.md',
      'crm-detail.md',
      'expired-rule.md',
      'heavy-rule.md',
      'retired-rule.md',
    ])
    expect(new Set(ids).size).toBe(ids.length) // exactly one verdict per note
    expect(r.unaccounted).toEqual([])
    expect(r.summary.unaccounted).toBe(0)
    expect(r.summary.corpus_total).toBe(6)
    expect(r.summary.selected_count).toBe(r.selected.length)
    expect(r.summary.rejected_count).toBe(r.rejected.length)

    // every verdict carries its grounds — a verdict without one is not an explanation
    for (const s of r.selected) expect(typeof s.basis).toBe('string')
    for (const x of r.rejected) expect(typeof x.reason).toBe('string')
  })

  it('two runs over the same inputs explain identically (no clock, no order noise)', () => {
    expect(JSON.stringify(explainRetrieval(opts()))).toBe(JSON.stringify(explainRetrieval(opts())))
  })
})

describe('a rejection names the filter and the field that decided it (Test 2)', () => {
  const reasonOf = (r: any, id: string) => (r.rejected.find((x: any) => x.id === id) ?? {}) as any

  it('a retired record is rejected by status, and says so by field and value', () => {
    const r = explainRetrieval(opts())
    const v = reasonOf(r, 'retired-rule.md')
    expect(v.reason).toBe(EXPLAIN_REASONS.STATUS_RETIRED)
    expect(v.detail.field).toBe('status')
    expect(v.detail.value).toBe('superseded')
  })

  it('an expired record is rejected by its own valid_until, not by status', () => {
    const r = explainRetrieval(opts())
    const v = reasonOf(r, 'expired-rule.md')
    expect(v.reason).toBe(EXPLAIN_REASONS.EXPIRED)
    expect(v.detail.field).toBe('valid_until')
    expect(v.detail.value).toBe('2026-01-01')
  })

  it('a record above the audience ceiling is rejected by sensitivity, naming both sides', () => {
    writeNote('secret-rule.md', { description: 'an internal crm rule', kind: 'reference', tags: '[crm]', importance: '5', sensitivity: 'internal' })
    const r = explainRetrieval({ ...opts(), audience: 'export' })
    const v = reasonOf(r, 'secret-rule.md')
    expect(v.reason).toBe(EXPLAIN_REASONS.SENSITIVITY_CEILING)
    expect(v.detail.field).toBe('sensitivity')
    expect(v.detail.value).toBe('internal')
    expect(v.detail.audience).toBe('export')
    expect(v.detail.ceiling).toBe('public')
  })

  it('a record the task never asked for is rejected for no tag overlap — not by a filter', () => {
    const r = explainRetrieval(opts())
    const v = reasonOf(r, 'auth-detail.md')
    expect(v.reason).toBe(EXPLAIN_REASONS.NO_TAG_OVERLAP)
    expect(v.detail.query).toEqual(['crm'])
  })

  it('a record squeezed out by the budget is rejected as a budget cut, with its position', () => {
    // A budget that fits the header and nothing more: every note is cut, and the cut is
    // reported as a BUDGET decision — not as an absence anybody has to guess about.
    const r = explainRetrieval({ ...opts(), budget: 120 })
    const cut = r.rejected.filter((x: any) => x.reason === EXPLAIN_REASONS.BUDGET_CUT)
    expect(cut.length).toBeGreaterThan(0)
    expect(cut.map((x: any) => x.id)).toContain('always-rule.md')
    const first = cut.find((x: any) => x.id === 'always-rule.md') as any
    expect(Number.isInteger(first.detail.position)).toBe(true)
    expect(first.detail.budget).toBe(120)
  })

  it('the reason vocabulary is a frozen export, not a set of strings written twice', () => {
    expect(Object.isFrozen(EXPLAIN_REASONS)).toBe(true)
    const r = explainRetrieval({ ...opts(), budget: 120 })
    const legal = new Set(Object.values(EXPLAIN_REASONS))
    for (const x of r.rejected) expect(legal.has(x.reason)).toBe(true)
  })
})

describe('a selection names its grounds (Test 3)', () => {
  const basisOf = (r: any, id: string) => (r.selected.find((s: any) => s.id === id) ?? {}) as any

  it('the CORE rule, the weight and the tag intersection are three different bases', () => {
    const r = explainRetrieval(opts())

    expect(basisOf(r, 'always-rule.md').basis).toBe(EXPLAIN_REASONS.CORE)
    expect(basisOf(r, 'heavy-rule.md').basis).toBe(EXPLAIN_REASONS.WEIGHT)
    expect(basisOf(r, 'crm-detail.md').basis).toBe('tag:crm')

    // and the pack position is carried, so «why is it twelfth» is an answerable question
    expect(Number.isInteger(basisOf(r, 'crm-detail.md').position)).toBe(true)
  })

  it('a task naming no registered facet says so, rather than claiming a tag it never matched', () => {
    const r = explainRetrieval({ ...opts(), task: 'probe' })
    expect(r.tags).toEqual([])
    const s = r.selected.find((x: any) => x.id === 'crm-detail.md') as any
    expect(s.basis).toBe(EXPLAIN_REASONS.UNCONSTRAINED)
  })
})

describe('the trace explains the real selection and does not move it (Test 4)', () => {
  it('the selected set is exactly the note set the untraced compile delivers, in pack order', () => {
    const real = compilePack({ taskText: 'fix the crm handler', commit: 'c', corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), now: NOW })
    const realNotes = real.members.filter((m: any) => m.type === 'note').map((m: any) => String(m.id))

    const r = explainRetrieval(opts())
    expect(r.selected.map((s: any) => s.id)).toEqual(realNotes)
  })

  it('the same holds under a budget that cuts, which is where a second implementation would drift', () => {
    const budget = 260
    const real = compilePack({ taskText: 'fix the crm handler', commit: 'c', corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), now: NOW, budget })
    const realNotes = real.members.filter((m: any) => m.type === 'note').map((m: any) => String(m.id))

    const r = explainRetrieval({ ...opts(), budget })
    expect(r.selected.map((s: any) => s.id)).toEqual(realNotes)
    expect(realNotes.length).toBeGreaterThan(0) // the case would be vacuous otherwise
  })

  it('a traced compile produces byte-identical pack bytes — the collector observes, it never decides', () => {
    const args = { taskText: 'fix the crm handler', commit: 'c', corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), now: NOW }
    const untraced = compilePack(args)
    const events: any[] = []
    const traced = compilePack({ ...args, trace: events })

    expect(traced.packMd).toBe(untraced.packMd)
    expect(traced.manifestJson).toBe(untraced.manifestJson)
    expect(events.length).toBeGreaterThan(0) // the trace was actually collected
  })
})

describe('the verb — sma memory explain (Test 5)', () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')

  /** A whole throwaway project: an .sma root and a corpus with one always-load note. */
  function seedProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'sma-explain-cli-'))
    const memory = join(root, '.claude', 'memory')
    mkdirSync(join(root, '.sma'), { recursive: true })
    mkdirSync(memory, { recursive: true })
    writeFileSync(join(memory, 'TAGS.md'), TAGS, 'utf8')
    writeFileSync(join(memory, 'MEMORY.md'), '# index\n- a core line\n', 'utf8')
    writeFileSync(
      join(memory, 'core-rule.md'),
      '---\ndescription: the always-loaded rule\nkind: reference\ntags: [crm]\nimportance: 9\n---\nbody\n',
      'utf8',
    )
    writeFileSync(
      join(memory, 'auth-detail.md'),
      '---\ndescription: an auth note a crm task never names\nkind: reference\ntags: [auth]\nimportance: 3\n---\nbody\n',
      'utf8',
    )
    return root
  }

  function runCli(root: string, args: string[]): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execFileSync('node', [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, SMA_ROOT_OVERRIDE: join(root, '.sma') },
      })
      return { stdout, stderr: '', status: 0 }
    } catch (err: any) {
      return {
        stdout: (err.stdout ?? '').toString(),
        stderr: (err.stderr ?? '').toString(),
        status: typeof err.status === 'number' ? err.status : 1,
      }
    }
  }

  let root: string
  beforeEach(() => {
    root = seedProject()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('--stat prints ONE bare number as the last line and exits 0', () => {
    const res = runCli(root, ['memory', 'explain', '--task', 'fix the crm handler', '--stat', 'unaccounted'])
    expect(res.status).toBe(0)
    const last = res.stdout.trim().split('\n').pop() as string
    expect(last).toBe('0')

    const rejected = runCli(root, ['memory', 'explain', '--task', 'fix the crm handler', '--stat', 'no_tag_overlap'])
    expect(rejected.status).toBe(0)
    expect(Number(rejected.stdout.trim())).toBe(1) // the auth note the task never named
  })

  it('an unknown --stat prints the legal names — taken from the report itself — and exits 1', () => {
    const res = runCli(root, ['memory', 'explain', '--task', 'anything', '--stat', 'no-such-number'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('unaccounted')
    expect(res.stderr).toContain('selected_count')
  })

  it('without --task it refuses with the syntax, and explains nothing', () => {
    const res = runCli(root, ['memory', 'explain'])
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('--task')
    expect(res.stderr).toContain('--task')
  })

  it('--json carries the per-note verdicts of the REAL selection', () => {
    const res = runCli(root, ['memory', 'explain', '--task', 'fix the crm handler', '--json'])
    expect(res.status).toBe(0)
    const report = JSON.parse(res.stdout.trim().split('\n').pop() as string)
    expect(report.metric).toBe('memory-explain')
    expect(report.selected.map((s: any) => s.id)).toEqual(['core-rule.md'])
    expect(report.selected[0].basis).toBe(EXPLAIN_REASONS.WEIGHT)
    expect(report.rejected.map((r: any) => r.id)).toEqual(['auth-detail.md'])
    expect(report.rejected[0].reason).toBe(EXPLAIN_REASONS.NO_TAG_OVERLAP)
    expect(report.unaccounted).toEqual([])
  })
})
