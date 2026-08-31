/**
 * memory-forget.test.ts — the ONE user-facing way to make the system stop
 * believing something, and the one flag that destroys it.
 *
 * The product decision behind this file: a person types ONE command to
 * forget a record and ONE flag to erase it completely. The five internal
 * lifecycle states — supersede, revoke, expire, archive, erase — live underneath
 * and are visible in the record's own history afterwards, but nobody is obliged
 * to learn the difference between them in order to forget something.
 *
 *   THE VERB SURFACE DOES NOT GROW. `forget` is a SUBCOMMAND of the existing
 *   `memory` namespace, exactly as `memory index` was before it. The
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
 *   THE CALLER CONTRACT IS ASSERTED, NOT ASSUMED. `eraseRecord`
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
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

  it('Test 7b: --archive really removes the record from the pack', () => {
    // `--archive` promises «out of active retrieval, kept for history» while the
    // read path acted on two of the four retirements, so an archived record was
    // still delivered. A forget flag that leaves the record quotable is a flag
    // that lies about what it did — asserted through the REAL pack, both sides.
    const id = 'working-depot-scanner-archived'
    seed(corpusDir, record({ id }))
    expect(packedIds()).toContain(`${id}.md`)

    const res = runCli(['memory', 'forget', id, '--corpus', corpusDir, '--archive'])
    expect(res.status).toBe(0)
    expect(packedIds()).not.toContain(`${id}.md`)

    // `--expire` has no equivalent assertion to make, and the absence is the point:
    // the action refuses unless `valid_until` has already passed, and a record whose
    // date has passed is ALREADY withheld by the window check. Writing the same test
    // for it would pass without the status filter existing at all.
  })

  it('Test 8: the top-level verb table gains NO key — forget is a subcommand', () => {
    const source = readFileSync(CLI, 'utf8')
    const start = source.indexOf('const HANDLERS = {')
    expect(start).toBeGreaterThan(0)
    const block = source.slice(start, source.indexOf('\n}', start))
    const keys = [...block.matchAll(/^\s{2}'?[a-zA-Z0-9:_-]+'?:/gm)].length
    // The pinned number moves ONLY when a genuinely new top-level verb lands, and whoever lands
    // one re-pins it here deliberately — that is the point of pinning a count rather than a
    // floor. It was 90; two verbs arrived independently and each side of the merge had raised it
    // to 91 for its own arrival, which is exactly how a count silently stops counting. It became
    // 92: the history search became a verb of its own, and so did the worker's parking gate.
    // It is 93 for the third time in the same shape — the standing acceptance rules arrived as a
    // verb of their own from a line of work whose own count read 91, counting only its own
    // arrival. The pin is the SUM of what actually landed, never one side's figure.
    // It is 95 for the FOURTH time in the same shape, and this time the shape arrived whole:
    // two lines of work landed a verb each — the per-turn diff verdict and the declared-wire
    // inventory — and each pinned 94, counting only its own arrival. Neither figure described
    // the tree that holds both. The pin is the SUM of what actually landed, never one side's
    // number; the comment on the allow-list beside the dispatch table says the same thing,
    // and it said it before this merge rather than after.
    // Note that this is the SECOND lock on the same number — the docs audit holds the other
    // six places — so the two move together or not at all.
    // It is 96 for the FIFTH time in the same shape: the journal chain's acknowledgment
    // ritual arrived as its own verb — the break stays evidence, and a human's written
    // reason is the only thing that moves it out of the red count.
    // It is 97 for the SIXTH time in the same shape: the onboarding value map arrived as its own
    // verb — `/sma-start` now prints what SMA will do in this repository BEFORE its first
    // question, and a map that has to be rendered before anything is asked is a command a
    // person can run themselves, not a paragraph inside a workflow.
    // It is 99 for the SEVENTH time in the same shape, and this time the shape arrived whole
    // TWICE OVER — two verbs landed from two lines of work, and each side pinned 98, counting
    // only its own arrival:
    //   - the branch-sync door — a worker owes the trunk brought into its branch BEFORE it hands
    //     the work over, and the bare merge verb is refused to it by the launch arguments on
    //     purpose. A duty with nothing to perform it with is a paragraph, not a duty, so the
    //     duty got a verb;
    //   - the fleet window's front door. The window's auth was never the problem — the token on
    //     every route and the HttpOnly cookie stand untouched; what was missing was any command
    //     that performed the one sanctioned exchange, so opening your own window meant lifting a
    //     token out of a config file and assembling an address by hand after every daemon
    //     restart.
    // The pin is the SUM of what actually landed, never one side's figure — which is the whole
    // reason this number is pinned rather than floored, and it is the SEVENTH time it has been
    // said in this comment.
    // The claim this case actually makes is the line below it: the deletion surface stayed a
    // SUBCOMMAND of the corpus namespace and never grew a top-level key, which is what a count
    // alone could never say.
    expect(keys).toBe(99)
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

  it('Test 10b: a non-destructive forget rebuilds the generated index — MEMORY.md stops quoting the record', () => {
    // The verb's own promise is «убрана из активной выдачи». MEMORY.md is the
    // one artifact sessions load first, and its CORE lines quote claim text —
    // a transition that left it stale would keep the retired claim in every
    // session start until someone happened to regenerate.
    seedCorpus({ context_priority: 'always' })
    seedDerivedIndexes()
    expect(readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')).toContain(`${SUBJECT}.md`)

    const res = forget(['--reason', 'the evening window claim was withdrawn'])

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('индексы перестроены')
    const index = readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')
    expect(index).not.toContain(`${SUBJECT}.md`)
    // rebuilt through the ONE builder, anchor inherited from the artifact header
    expect(index).toBe(buildIndex({ corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commitHash: '0000000', dateMap: {} }))
    // the record itself survives — retired, and still catalogued in an area
    // index for history, exactly as the README's filtered-delivery paragraph says
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
    const areaFiles = readdirSync(corpusDir).filter((f: string) => /^INDEX-.+\.md$/.test(f))
    expect(areaFiles.length).toBeGreaterThan(0)
    const catalogued = areaFiles.map((f: string) => readFileSync(join(corpusDir, f), 'utf8')).join('\n')
    expect(catalogued).toContain(`${SUBJECT}.md`)
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

    // The mechanical check: the caller passed the store paths, so
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

  it('Test 14b: an episode sharing the id makes the CLI DECLINE — non-zero, path named, nothing removed', () => {
    // The module-level proof is erase.test.ts Tests 29-32; this one asserts the
    // refusal survives the trip to the operator's terminal, because a decline
    // that exits 0 or prints nothing is indistinguishable from a completed
    // erase.
    seedCorpus()
    seed(join(corpusDir, 'episodes'), record({ status: 'archived', memory_type: 'episodic' }))
    seedDerivedIndexes()
    const indexBefore = readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')

    const res = forget(['--erase', '--yes'])

    expect(res.status).not.toBe(0)
    expect(res.out).toContain(`${SUBJECT}.md`)
    expect(res.out).toMatch(/episod/i)
    // fail-closed: every copy is still where it was, read back from disk, and
    // the derived index was not even rebuilt — the refusal lands before the
    // first surface is touched, not after a partial run.
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
    expect(existsSync(join(corpusDir, 'episodes', `${SUBJECT}.md`))).toBe(true)
    expect(readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')).toBe(indexBefore)
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
