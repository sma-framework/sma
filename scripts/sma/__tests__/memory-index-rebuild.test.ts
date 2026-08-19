/**
 * Tests for the two points at which the derived lexical index gets rebuilt — both of
 * them in cli.mjs, and neither of them inside the pure compiler.
 *
 * WHY THIS FILE EXISTS SEPARATELY from the layer's own suite: the layer has been able to
 * build an index since the day it was written. What it could not do was get rebuilt by
 * anything other than a person remembering to type a command — and for weeks nobody did,
 * so the index sat describing a corpus that had moved on while every delivery quietly
 * fell back to the narrower answer. The defect was never in the layer; it was in the
 * absence of a caller. A test of the layer cannot catch that, so these cases drive the
 * REAL CLI and assert what the process on disk actually did.
 *
 *   - Case 1: the corpus regeneration rebuilds the lexical index too, and a staleness of
 *     one becomes zero without anybody typing a rebuild.
 *   - Case 2: a rebuild that cannot happen does NOT take the verb down with it, and the
 *     reason is printed rather than swallowed.
 *   - Case 3: the same, with the engine genuinely switched off for the child process
 *     (`--no-experimental-sqlite` — a LIVE absence, not a double): the regeneration still
 *     exits 0 and names what is missing, and the delivery answers from the facets and
 *     says why. This is the branch a user on an official Node build is actually on.
 *   - Case 4: the delivery repairs the index ONLY when it is stale. Both halves are
 *     asserted, because each half alone is a different bug: never repairing is the defect
 *     this work exists to fix, and always repairing is a rebuild tacked onto every single
 *     call. A sentinel written into the index's own meta file is the evidence — it
 *     survives a delivery over a fresh index and is gone after one over a stale one.
 *   - Case 5: a corpus named by flag never rebuilds the repository's index. The derived
 *     index describes THIS repository's records, and a run over somebody's fixture that
 *     overwrote it would leave the next real delivery reading a stranger's corpus.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lexicalCapability, LEXICAL_INDEX_FILE, metaPathFor } from '../lib/fts-index.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')
const CAP = lexicalCapability()
const EMDASH = String.fromCharCode(0x2014)

/** A value no rebuild would ever write, so its survival is proof nothing rebuilt. */
const SENTINEL_BUILT_AT = '1999-01-01T00:00:00.000Z'

let repo: string

function note(description: string, tags: string, importance: number) {
  return `---\ndescription: ${description}\nkind: reference\ntags: [${tags}]\nimportance: ${importance}\n---\nbody text\n`
}

/** A repository with a corpus and NO derived index — where every user starts. */
function seedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sma-index-rebuild-'))
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' })
  const corpus = join(root, '.claude', 'memory')
  mkdirSync(corpus, { recursive: true })
  writeFileSync(
    join(corpus, 'TAGS.md'),
    `# TAGS\n\n## area\n- tech ${EMDASH} infra, build.\n- docs ${EMDASH} documentation.\n\n## kind\n- reference ${EMDASH} a lookup fact.\n\n## phase\n- Open facet: phase:NN.\n`,
    'utf8',
  )
  writeFileSync(join(corpus, 'core-rule.md'), note('the always-loaded rule', 'tech', 9), 'utf8')
  // the scenario in one file: «pangolin» lives in the claim and in NO tag
  writeFileSync(join(corpus, 'pangolin-fact.md'), note('the pangolin release ships on tuesdays', 'docs', 4), 'utf8')
  return root
}

const corpusDir = () => join(repo, '.claude', 'memory')
const dbPath = () => join(repo, '.sma', 'index', LEXICAL_INDEX_FILE)

function run(args: string[], nodeFlags: string[] = []): { stdout: string; stderr: string; status: number } {
  const res = spawnSync('node', [...nodeFlags, CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, SMA_ROOT_OVERRIDE: join(repo, '.sma'), NODE_OPTIONS: '--no-warnings' },
  })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? 1 }
}

/** The bare staleness number the status verb prints — the caller's view of it. */
function stale(): string {
  return run(['memory', 'index', 'status', '--stat', 'stale']).stdout.trim().split('\n').pop() ?? ''
}

function stampSentinel() {
  const metaPath = metaPathFor(dbPath())
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  meta.built_at = SENTINEL_BUILT_AT
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')
}

function sentinelSurvives(): boolean {
  return JSON.parse(readFileSync(metaPathFor(dbPath()), 'utf8')).built_at === SENTINEL_BUILT_AT
}

beforeEach(() => {
  repo = seedRepo()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true, maxRetries: 3 })
})

describe('the corpus regeneration rebuilds the derived lexical index too', () => {
  it.skipIf(!CAP.module)('turns a staleness of one into zero without a hand-typed rebuild', () => {
    // an index that has never been built counts as stale, and says so to the caller
    expect(stale()).toBe('1')
    expect(existsSync(dbPath())).toBe(false)

    const res = run(['build-index', '--write'])

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('лексический индекс пересобран')
    expect(existsSync(dbPath())).toBe(true)
    expect(stale()).toBe('0')
  })

  it('prints what happened to the lexical index whether or not it could be rebuilt', () => {
    const res = run(['build-index', '--write'])
    expect(res.status).toBe(0)
    // one of the two sentences is always there: a repair nobody can see is a repair
    // nobody can trust, and silence would read the same on either branch
    expect(res.stdout).toMatch(/лексический индекс (пересобран|НЕ пересобран)/)
  })

  it('survives a rebuild that cannot happen, and names the reason instead of swallowing it', () => {
    // something impossible to write over sits exactly where the index file goes
    mkdirSync(dbPath(), { recursive: true })

    const res = run(['build-index', '--write'])

    // the corpus index — the work the verb was actually asked for — still happened
    expect(res.status).toBe(0)
    expect(existsSync(join(corpusDir(), 'MEMORY.md'))).toBe(true)
    expect(res.stdout).toContain('лексический индекс НЕ пересобран')
  })
})

describe('with the engine genuinely absent from the child process', () => {
  // Not a double: the flag removes node:sqlite from the runtime, so this is the branch
  // an adopter on a build without it is really on, exercised end to end.
  const NO_ENGINE = ['--no-experimental-sqlite']

  it('regenerates the corpus index, exits 0, and names what is missing', () => {
    const res = run(['build-index', '--write'], NO_ENGINE)

    expect(res.status).toBe(0)
    expect(existsSync(join(corpusDir(), 'MEMORY.md'))).toBe(true)
    expect(res.stdout).toContain('лексический индекс НЕ пересобран')
    expect(res.stdout).toContain('node:sqlite')
    // nothing was written where the index would go — an absent engine builds nothing
    expect(existsSync(dbPath())).toBe(false)
  })

  it('answers the delivery from the facets and says why, rather than failing', () => {
    const res = run(['load', '--tags', 'pangolin', '--json'], NO_ENGINE)

    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.meta.lexical.degraded).toBe(true)
    expect(parsed.warnings.join(' ')).toContain('fusion-degraded')
    // and the record only a word could reach is honestly NOT there
    expect(parsed.periphery).not.toContain('pangolin-fact.md')
  })
})

describe('the delivery repairs the index only when it is stale', () => {
  it.skipIf(!CAP.module)('leaves a FRESH index alone — no rebuild is tacked onto every call', () => {
    expect(run(['memory', 'index', 'rebuild']).status).toBe(0)
    stampSentinel()

    const res = run(['load', '--tags', 'pangolin', '--json'])
    expect(res.status).toBe(0)

    // the mark a rebuild would have wiped is still there: nothing was rebuilt
    expect(sentinelSurvives()).toBe(true)
    // …and the fresh index was still USED, so this is not a delivery that skipped it
    expect(JSON.parse(res.stdout).periphery).toContain('pangolin-fact.md')
  })

  it.skipIf(!CAP.module)('rebuilds a STALE one, and the word added since reaches the record', () => {
    expect(run(['memory', 'index', 'rebuild']).status).toBe(0)
    stampSentinel()

    // the axis of the corpus moves: a word that was in no index a moment ago
    writeFileSync(join(corpusDir(), 'wolverine-fact.md'), note('the wolverine build runs on fridays', 'tech', 4), 'utf8')
    expect(stale()).toBe('1')

    // nobody types a rebuild between these two lines
    const res = run(['load', '--tags', 'wolverine', '--json'])
    expect(res.status).toBe(0)

    expect(sentinelSurvives()).toBe(false)
    expect(JSON.parse(res.stdout).periphery).toContain('wolverine-fact.md')
    expect(stale()).toBe('0')
  })
})

describe('a corpus named by flag', () => {
  it.skipIf(!CAP.module)('never rebuilds the repository’s own derived index', () => {
    expect(run(['memory', 'index', 'rebuild']).status).toBe(0)
    stampSentinel()

    // a fixture corpus somewhere else entirely, sharing not one record with this one
    const fixture = join(repo, 'fixture-corpus')
    mkdirSync(fixture, { recursive: true })
    writeFileSync(join(fixture, 'other.md'), note('an unrelated fixture record', 'tech', 3), 'utf8')

    const res = run(['load', '--corpus', fixture, '--tags', 'pangolin', '--json'])

    expect(res.status).toBe(0)
    // the repository's index was neither rebuilt from the fixture nor touched at all
    expect(sentinelSurvives()).toBe(true)
    // and the run over the fixture is honest about answering without the layer
    expect(JSON.parse(res.stdout).meta.lexical.degraded).toBe(true)
  })
})
