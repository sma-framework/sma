/**
 * memory-forget.test.ts — the ONE user-facing way to make the system stop
 * believing something, and the one flag that destroys it.
 *
 * The product decision behind this file (D-11-06): a person types ONE command to
 * forget a record and ONE flag to erase it completely. The five internal
 * lifecycle states — supersede, revoke, expire, archive, erase — live underneath
 * and are visible in the record's own history afterwards, but nobody is obliged
 * to learn the difference between them in order to forget something.
 *
 *   THE VERB SURFACE DOES NOT GROW. `forget` is a SUBCOMMAND of the existing
 *   `memory` namespace (D-11-08), exactly as `memory index` was in phase 10. The
 *   top-level HANDLERS table is asserted below to gain no key.
 *
 *   THE DESTRUCTIVE PATH IS NEVER THE DEFAULT AND NEVER IMPLICIT. `--erase`
 *   alone changes nothing: it prints what it WOULD destroy and refuses. Consent
 *   is the explicit `--yes` flag — the posture every other irreversible verb in
 *   this CLI already uses (`force-clear`, `gates override`, `memory migrate
 *   --apply`, `undo`). There is no terminal prompt anywhere in this product, so
 *   a MISSING terminal can never be mistaken for consent: every run below is
 *   non-interactive and the refusal still fires.
 *
 *   THE UNPLEASANT TRUTH IS IN THE OUTPUT, NOT ONLY IN THE DOCS. A record that
 *   reached a commit is still in that commit and in every clone. The destructive
 *   path says so in its own words, both when it refuses and when it succeeds.
 *
 *   THE CALLER CONTRACT IS ASSERTED, NOT ASSUMED (D-11-DEFER-14). `eraseRecord`
 *   refuses to invent the paths of the `.sma` stores it would delete from, so an
 *   erase whose caller forgets to pass them silently skips the this-machine-only
 *   store and the lexical index. The mechanical check is one line: `unverified`
 *   must come back EMPTY from the real command.
 *
 * Every test drives the REAL cli.mjs in a child process against a per-test temp
 * repo through SMA_ROOT_OVERRIDE. Nothing here ever points the command at a real
 * `.claude/memory/` — this file builds and destroys only its own fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ERASE_SURFACES } from '../lib/erase.mjs'
import { serializeNote, parseNote } from '../lib/frontmatter.mjs'
import { buildIndex, buildAreaIndexes } from '../lib/generator.mjs'
import { buildLexicalIndex, LEXICAL_INDEX_FILE } from '../lib/fts-index.mjs'
import { compilePack } from '../lib/context-pack.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')

const EMDASH = String.fromCharCode(0x2014)

/** The record every test forgets, and the neighbour that must survive it. */
const SUBJECT = 'working-depot-scanner-evening-window'
const SUCCESSOR = 'working-depot-scanner-evening-window-v2'
const NEIGHBOUR = 'working-depot-scanner-morning-window'

/** The task text the pack assertions compile against. */
const TASK = 'the depot scanner evening backlog'

let repoRoot: string
let smaRoot: string
let corpusDir: string
let draftsDir: string
let localDir: string
let indexDir: string
let dbPath: string

/**
 * A well-formed schema-v2 record about an invented courier depot. No corpus
 * text, no real path, no personal data.
 */
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBJECT,
    schema_version: '2',
    status: 'active',
    memory_type: 'working',
    truth_mode: 'observed',
    claim: 'The depot scanner clears the evening backlog in under four minutes',
    language: 'en',
    sensitivity: 'internal',
    risk: 'low',
    fingerprint: { product_version: 'v5.1.0' },
    retrieval: { areas: ['depot'] },
    ...overrides,
  }
}

/** Write a record into an arbitrary directory through the shared serializer. */
function seed(dir: string, frontmatter: Record<string, unknown>, body = '\nSeeded fixture.\n') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${frontmatter.id}.md`), serializeNote({ frontmatter, body, schemaVersion: 2 }))
}

/** The corpus every test starts from: the subject plus one untouched neighbour. */
function seedCorpus(overrides: Record<string, unknown> = {}) {
  seed(corpusDir, record(overrides))
  seed(
    corpusDir,
    record({
      id: NEIGHBOUR,
      claim: 'The depot scanner clears the morning backlog in under six minutes',
    }),
  )
}

/** Rebuild the derived index artifacts the way the product does. */
function seedDerivedIndexes() {
  const args = { corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commitHash: '0000000', dateMap: {} }
  writeFileSync(join(corpusDir, 'MEMORY.md'), buildIndex(args))
  for (const a of buildAreaIndexes(args)) writeFileSync(join(corpusDir, a.file), a.content)
  return buildLexicalIndex({ corpusDir, dbPath, now: '2026-08-04T00:00:00.000Z' })
}

/** The frontmatter of a record as it is on disk right now, or null when it is gone. */
function frontmatterOf(dir: string, id: string): Record<string, unknown> | null {
  const path = join(dir, `${id}.md`)
  if (!existsSync(path)) return null
  return (parseNote(readFileSync(path, 'utf8'), { file: path }).frontmatter ?? null) as Record<string, unknown> | null
}

/**
 * Run the real CLI. Returns stdout, stderr, their concatenation and the exit
 * code — a refusal writes to stderr, and a test that read only stdout would call
 * a silent failure a pass.
 */
function runCli(args: string[]): { stdout: string; stderr: string; out: string; status: number } {
  const env = { ...process.env, SMA_ROOT_OVERRIDE: smaRoot, SMA_TERMINAL_NAME: 'test-forget' }
  try {
    const stdout = execFileSync('node', [CLI, ...args], { input: '', encoding: 'utf8', env })
    return { stdout, stderr: '', out: stdout, status: 0 }
  } catch (err: any) {
    const stdout = (err.stdout ?? '').toString()
    const stderr = (err.stderr ?? '').toString()
    return { stdout, stderr, out: `${stdout}${stderr}`, status: typeof err.status === 'number' ? err.status : 1 }
  }
}

/** `memory forget <id> …` against the fixture corpus. */
function forget(args: string[]) {
  return runCli(['memory', 'forget', SUBJECT, '--corpus', corpusDir, ...args])
}

/** The pack the real read path compiles from this corpus right now. */
function packedIds(): string[] {
  const res = compilePack({
    taskText: TASK,
    commit: 'c',
    corpusDir,
    tagsPath: join(corpusDir, 'TAGS.md'),
    now: '2026-08-04T00:00:00Z',
  }) as { members: { type: string; id: string }[] }
  return res.members.filter((m) => m.type === 'note').map((m) => m.id)
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'sma-forget-'))
  smaRoot = join(repoRoot, '.sma')
  corpusDir = join(repoRoot, '.claude', 'memory')
  draftsDir = join(corpusDir, 'drafts')
  localDir = join(smaRoot, 'local-memory')
  indexDir = join(smaRoot, 'index')
  dbPath = join(indexDir, LEXICAL_INDEX_FILE)
  mkdirSync(corpusDir, { recursive: true })
  mkdirSync(draftsDir, { recursive: true })
  mkdirSync(indexDir, { recursive: true })
  writeFileSync(
    join(corpusDir, 'TAGS.md'),
    `## area\n- depot ${EMDASH} the courier depot\n\n## kind\n- working ${EMDASH} a working observation\n`,
    'utf8',
  )
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

// ── Task 1: one command, the five states underneath ──────────────────────────

describe('memory forget — one command, and it says which state it applied', () => {
  it('Test 1: a bare forget revokes, names the state it chose, and exits 0', () => {
    seedCorpus()
    const res = forget(['--reason', 'the evening window was re-measured and the claim no longer holds'])

    expect(res.status).toBe(0)
    // the state is SHOWN, not hidden: the person is told which of the five ran
    expect(res.out).toContain(SUBJECT)
    expect(res.out).toMatch(/отозв/i)
    expect(res.out).toContain('status: revoked')
    // and it is in the record's own history, on disk
    expect(frontmatterOf(corpusDir, SUBJECT)?.status).toBe('revoked')
    // the neighbour is untouched — a forget is not a wipe
    expect(frontmatterOf(corpusDir, NEIGHBOUR)?.status).toBe('active')
  })

  it('Test 2: a forget naming a replacement supersedes and prints BOTH ids', () => {
    seedCorpus()
    seed(corpusDir, record({ id: SUCCESSOR, claim: 'The depot scanner clears the evening backlog in under two minutes' }))

    const res = forget(['--replaced-by', SUCCESSOR])
    expect(res.status).toBe(0)
    expect(res.out).toContain(SUBJECT)
    expect(res.out).toContain(SUCCESSOR)
    expect(res.out).toContain('status: superseded')

    // BOTH ends of the chain were written — the symmetry the lifecycle guarantees
    expect(frontmatterOf(corpusDir, SUBJECT)?.status).toBe('superseded')
    expect(frontmatterOf(corpusDir, SUBJECT)?.superseded_by).toBe(SUCCESSOR)
    expect(frontmatterOf(corpusDir, SUCCESSOR)?.supersedes).toBe(SUBJECT)
  })

  it('Test 3: an id that does not exist is refused BY NAME, with a non-zero exit', () => {
    seedCorpus()
    const res = runCli(['memory', 'forget', 'working-no-such-record-anywhere', '--corpus', corpusDir, '--reason', 'x'])

    expect(res.status).not.toBe(0)
    expect(res.out).toContain('working-no-such-record-anywhere')
    // nothing was touched on the way to the refusal
    expect(frontmatterOf(corpusDir, SUBJECT)?.status).toBe('active')
  })

  it('Test 4: a forgotten record is gone from the compiled pack — and WAS in it before', () => {
    seedCorpus()
    // the two-sided assertion: an absence proves nothing unless the presence is shown first
    expect(packedIds()).toContain(`${SUBJECT}.md`)

    const res = forget(['--reason', 'the evening window was re-measured and the claim no longer holds'])
    expect(res.status).toBe(0)

    const after = packedIds()
    expect(after).not.toContain(`${SUBJECT}.md`)
    expect(after).toContain(`${NEIGHBOUR}.md`)
  })

  it('Test 5: the memory namespace usage line lists forget among its subcommands', () => {
    const res = runCli(['memory'])
    expect(res.out).toContain('forget')
    expect(res.out).toMatch(/usage: sma memory/)
  })

  it('Test 6: a revocation with no stated reason is refused, and the refusal says what to add', () => {
    seedCorpus()
    const res = forget([])

    expect(res.status).not.toBe(0)
    expect(res.out).toContain('--reason')
    // refused means nothing changed
    expect(frontmatterOf(corpusDir, SUBJECT)?.status).toBe('active')
  })

  it('Test 7: expiry and archiving are REACHABLE by flag and are never the default', () => {
    seedCorpus({ valid_until: '2026-01-01' })
    const expired = forget(['--expire'])
    expect(expired.status).toBe(0)
    expect(frontmatterOf(corpusDir, SUBJECT)?.status).toBe('expired')

    // a second, independent corpus for the archive path
    seed(corpusDir, record({ id: NEIGHBOUR }))
    const archived = runCli(['memory', 'forget', NEIGHBOUR, '--corpus', corpusDir, '--archive'])
    expect(archived.status).toBe(0)
    expect(frontmatterOf(corpusDir, NEIGHBOUR)?.status).toBe('archived')
  })

  it('Test 8: the top-level verb table gains NO key — forget is a subcommand (D-11-08)', () => {
    const source = readFileSync(CLI, 'utf8')
    const start = source.indexOf('const HANDLERS = {')
    expect(start).toBeGreaterThan(0)
    const block = source.slice(start, source.indexOf('\n}', start))
    const keys = [...block.matchAll(/^\s{2}'?[a-zA-Z0-9:_-]+'?:/gm)].length
    expect(keys).toBe(90)
    // and the handler that WOULD have been added is absent by name
    expect(block).not.toContain('forget')
  })

  it('Test 9: a this-machine-only record is forgotten in ITS OWN store, not the corpus', () => {
    seedCorpus()
    // `sensitive` is the closed-vocabulary word that routes to this-machine-only
    seed(localDir, record({ id: SUBJECT, sensitivity: 'sensitive' }))
    rmSync(join(corpusDir, `${SUBJECT}.md`))

    const res = forget(['--reason', 'the restricted note was re-measured and no longer holds'])
    expect(res.status).toBe(0)
    expect(frontmatterOf(localDir, SUBJECT)?.status).toBe('revoked')
    expect(res.out).toContain('this-machine-only')
  })
})

// ── Task 2: the erase flag ───────────────────────────────────────────────────

describe('memory forget --erase — irreversible, confirmed once, honest about history', () => {
  it('Test 10: without the destructive flag the file is still on disk afterwards', () => {
    seedCorpus()
    const res = forget(['--reason', 'the evening window was re-measured and the claim no longer holds'])

    expect(res.status).toBe(0)
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
  })

  it('Test 11: --erase WITHOUT --yes refuses, deletes nothing, and says what it would have done', () => {
    seedCorpus()
    seedDerivedIndexes()

    const res = forget(['--erase'])
    expect(res.status).not.toBe(0)
    // the file is still there — a refusal changes nothing
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
    // and the refusal names the consent flag and the exact command to repeat
    expect(res.out).toContain('--yes')
    expect(res.out).toContain(SUBJECT)
    // it also names what it would have cleared, so consent is informed
    for (const surface of ERASE_SURFACES) expect(res.out).toContain(surface.name)
  })

  it('Test 12: a missing terminal is NOT consent — the guard is a flag, never a prompt', () => {
    seedCorpus()
    // every run in this file is non-interactive: stdin is an empty pipe and there
    // is no TTY. Test 11 already proves the refusal fires under exactly that
    // condition; this asserts the SOURCE can never learn to read a terminal instead.
    const source = readFileSync(CLI, 'utf8')
    expect(source).toContain('async function cmdMemoryForget')
    // asserted over the WHOLE CLI rather than one function body: a guard that can
    // be dodged by moving the code into a helper is not a guard. There is no
    // terminal prompt anywhere in this product, and this is what keeps it that way.
    expect(source).not.toContain('isTTY')
    expect(source).not.toContain('createInterface')

    // and behaviourally, once more, with stdin explicitly empty
    const res = forget(['--erase'])
    expect(res.status).not.toBe(0)
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
  })

  it('Test 13: --erase --yes clears EVERY surface, reports each, and leaves nothing unverified', () => {
    seedCorpus()
    seed(draftsDir, record({ status: 'draft' }))
    seedDerivedIndexes()

    const res = forget(['--erase', '--yes', '--json'])
    expect(res.status).toBe(0)

    const result = JSON.parse(res.stdout)
    expect(result.applied).toBe(true)
    expect(result.failures).toEqual([])

    // D-11-DEFER-14, the mechanical check: the caller passed the store paths, so
    // no surface came back unreachable. An empty array here is the difference
    // between an erase that worked and one that only reported success.
    expect(result.unverified).toEqual([])

    // every member of the frozen list was walked and reported by name
    expect(result.surfaces.map((s: { surface: string }) => s.surface)).toEqual(ERASE_SURFACES.map((s) => s.name))

    // read the disk back: the copies are gone and the neighbour survived
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(false)
    expect(existsSync(join(draftsDir, `${SUBJECT}.md`))).toBe(false)
    expect(existsSync(join(corpusDir, `${NEIGHBOUR}.md`))).toBe(true)
    expect(readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')).not.toContain(`${SUBJECT}.md`)
  })

  it('Test 14: the human output of a completed erase names every surface it cleared', () => {
    seedCorpus()
    seedDerivedIndexes()

    const res = forget(['--erase', '--yes'])
    expect(res.status).toBe(0)
    for (const surface of ERASE_SURFACES) expect(res.out).toContain(surface.name)
  })

  it('Test 15: the output says the unpleasant thing about git history, in both paths', () => {
    seedCorpus()

    const refused = forget(['--erase'])
    const done = forget(['--erase', '--yes'])

    for (const res of [refused, done]) {
      expect(res.out).toMatch(/git/i)
      expect(res.out).toMatch(/истори/i)
      expect(res.out).toMatch(/копи|клон/i)
    }
  })

  it('Test 16: a surface that cannot be cleared makes the command FAIL and names that surface', () => {
    seedCorpus()
    // a directory where a file is expected: rmSync without `recursive` refuses it,
    // so the drafts surface genuinely fails rather than being told to fail
    mkdirSync(join(draftsDir, `${SUBJECT}.md`, 'inside'), { recursive: true })

    const res = forget(['--erase', '--yes'])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('drafts')
    // the corpus copy still went — a partial erasure stays informative about what DID happen
    expect(res.out).toContain('corpus')
  })

  it('Test 17: erasing a record that does not exist refuses without touching anything', () => {
    seedCorpus()
    const res = runCli([
      'memory',
      'forget',
      'working-no-such-record-anywhere',
      '--corpus',
      corpusDir,
      '--erase',
      '--yes',
    ])

    expect(res.status).not.toBe(0)
    expect(res.out).toContain('working-no-such-record-anywhere')
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
    expect(existsSync(join(corpusDir, `${NEIGHBOUR}.md`))).toBe(true)
  })

  it('Test 18: --erase and a transition flag together are refused rather than guessed at', () => {
    seedCorpus()
    const res = forget(['--erase', '--yes', '--archive'])

    expect(res.status).not.toBe(0)
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
  })
})
