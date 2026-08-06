/**
 * Tests for scripts/sma/lib/erase.mjs — THE ONE DESTRUCTIVE EFFECT.
 *
 * Erasure is the only operation in the memory layer that destroys rather than
 * transitions, so these tests are written the only way a destructive operation
 * can honestly be tested: EVERY assertion reads the surface back from disk. Not
 * one of them trusts the return value about whether a copy is gone — a delete
 * that reports success while a copy survives on a derived index is exactly the
 * failure the operation exists to prevent, and a test that believed the report
 * would be blind to it.
 *
 *   ONE LIST, WALKED TWICE. `ERASE_SURFACES` names every place a copy can live;
 *   `eraseRecord` clears that list and `verifyErasure` walks the same one. The
 *   pair cannot drift, because there is only one list to drift from.
 *
 *   A PARTIAL ERASURE IS A FAILURE. An injected removal failure on one surface
 *   produces a failure result naming that surface — and the surfaces that DID
 *   succeed stay enumerated, because an operator who is told only "it failed"
 *   cannot know what state the corpus is now in.
 *
 *   THE JOURNAL IS EVIDENCE, NOT A COPY. It keeps a pointer and an event, never
 *   the content, so keeping it does not defeat the deletion — and a deletion
 *   that erased the record of itself could not be audited at all.
 *
 *   HISTORY IS NOT TOUCHED, AND THE RESULT SAYS SO. No git command is executed
 *   by any code path in the module. Automatic history rewriting was rejected
 *   deliberately; the honest line is carried in the result, not in a promise.
 *
 * EVERY fixture corpus is built in a fresh temp directory. Nothing in this file
 * ever points an erase call at a real `.claude/memory/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ERASE_SURFACES, eraseRecord, verifyErasure } from '../lib/erase.mjs'
import { LIFECYCLE_ACTIONS, applyLifecycle } from '../lib/write-pipeline.mjs'
import { appendEvent } from '../lib/journal.mjs'
import { serializeNote, parseNote } from '../lib/frontmatter.mjs'
import { buildIndex, buildAreaIndexes } from '../lib/generator.mjs'
import { buildLexicalIndex, queryLexical, LEXICAL_ENGINES, LEXICAL_INDEX_FILE } from '../lib/fts-index.mjs'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

const SUBJECT = 'working-depot-scanner-evening-window'
const NEIGHBOUR = 'working-depot-scanner-morning-window'

let root: string
let corpusDir: string
let draftsDir: string
let episodesDir: string
let localDir: string
let indexDir: string
let dbPath: string
let journalDir: string

/**
 * A well-formed schema-v2 record about an invented courier company. No corpus
 * text, no real path, no personal data — a fixture, not a copy of anything.
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

/** Put the subject on every copy surface at once. */
function seedEverySurface(overrides: Record<string, unknown> = {}) {
  seed(corpusDir, record(overrides))
  seed(draftsDir, record({ ...overrides, status: 'draft' }))
  seed(localDir, record(overrides))
}

/** Rebuild the derived index artifacts the way the product does. */
function seedDerivedIndexes() {
  const args = { corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commitHash: '0000000', dateMap: {} }
  writeFileSync(join(corpusDir, 'MEMORY.md'), buildIndex(args))
  for (const a of buildAreaIndexes(args)) writeFileSync(join(corpusDir, a.file), a.content)
  return buildLexicalIndex({ corpusDir, dbPath, now: '2026-08-04T00:00:00.000Z' })
}

/** The erase call every test uses — always against the temp fixture, never a real corpus. */
function ctx(extra: Record<string, unknown> = {}) {
  return {
    corpusDir,
    draftsDir,
    localDir,
    dbPath,
    journalDir,
    terminalId: 'test-erase',
    now: '2026-08-04T12:00:00.000Z',
    commitHash: '0000000',
    ...extra,
  }
}

function erase(extra: Record<string, unknown> = {}) {
  return eraseRecord({ id: SUBJECT, ...ctx(extra) })
}

/** Every INDEX-*.md file that exists in the corpus right now. */
function areaIndexFiles(): string[] {
  return readdirSync(corpusDir)
    .filter((f) => /^INDEX-.+\.md$/.test(f))
    .sort()
}

/** Every journal line, raw. */
function journalRaw(): string {
  const path = join(journalDir, 'test-erase.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function journalEvents(): any[] {
  const raw = journalRaw().trim()
  return raw === '' ? [] : raw.split('\n').map((l) => JSON.parse(l))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-erase-'))
  corpusDir = join(root, 'memory')
  draftsDir = join(corpusDir, 'drafts')
  episodesDir = join(corpusDir, 'episodes')
  localDir = join(root, '.sma', 'local-memory')
  indexDir = join(root, '.sma', 'index')
  dbPath = join(indexDir, LEXICAL_INDEX_FILE)
  journalDir = join(root, 'journal')
  mkdirSync(corpusDir, { recursive: true })
  mkdirSync(draftsDir, { recursive: true })
  mkdirSync(episodesDir, { recursive: true })
  mkdirSync(localDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ERASE_SURFACES — one list, or the pair drifts', () => {
  it('Test 1: is frozen and names every surface a copy can live on', () => {
    expect(Object.isFrozen(ERASE_SURFACES)).toBe(true)
    expect(ERASE_SURFACES.map((s: any) => s.name)).toEqual([
      'corpus',
      'drafts',
      'local-store',
      'generated-index',
      'area-indexes',
      'lexical-index',
    ])
    for (const surface of ERASE_SURFACES as any[]) {
      expect(Object.isFrozen(surface)).toBe(true)
      expect(['copy', 'derived']).toContain(surface.kind)
      expect(typeof surface.describe).toBe('string')
      expect(surface.describe.length).toBeGreaterThan(10)
    }
  })

  it('Test 2: removal and verification report on the SAME list — neither can quietly skip one', () => {
    seedEverySurface()
    seedDerivedIndexes()

    const names = (ERASE_SURFACES as any[]).map((s) => s.name)
    const erased = erase()
    const verified = verifyErasure({ id: SUBJECT, ...ctx() })

    expect(erased.surfaces.map((s: any) => s.surface)).toEqual(names)
    expect(verified.surfaces.map((s: any) => s.surface)).toEqual(names)
  })
})

describe('eraseRecord — every surface, read back from disk', () => {
  it('Test 3: removes the record from the corpus, the drafts area and the local store', () => {
    seedEverySurface()
    seedDerivedIndexes()

    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
    expect(existsSync(join(draftsDir, `${SUBJECT}.md`))).toBe(true)
    expect(existsSync(join(localDir, `${SUBJECT}.md`))).toBe(true)

    const res = erase()

    expect(res.applied).toBe(true)
    // read back — the return value is not the evidence
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(false)
    expect(existsSync(join(draftsDir, `${SUBJECT}.md`))).toBe(false)
    expect(existsSync(join(localDir, `${SUBJECT}.md`))).toBe(false)
  })

  it('Test 4: the generated index no longer names the record — and it was REBUILT, not hand-edited', () => {
    seed(corpusDir, record({ context_priority: 'always' }))
    seed(corpusDir, record({ id: NEIGHBOUR, context_priority: 'always', claim: 'The morning window is clear' }))
    seedDerivedIndexes()
    expect(readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')).toContain(`${SUBJECT}.md`)

    erase()

    const after = readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')
    expect(after).not.toContain(`${SUBJECT}.md`)
    expect(after).not.toContain('clears the evening backlog')
    // the neighbour survives — an erase is not a wipe
    expect(after).toContain(`${NEIGHBOUR}.md`)
    // byte-identical to what the ONE builder produces now: it was regenerated
    expect(after).toBe(buildIndex({ corpusDir, tagsPath: join(corpusDir, 'TAGS.md'), commitHash: '0000000', dateMap: {} }))
  })

  it('Test 5: a surviving area index is rebuilt without the record', () => {
    // two periphery notes share an area, so the area index still has a reason to
    // exist afterwards — the assertion is about its CONTENT, not its absence.
    seed(corpusDir, record())
    seed(corpusDir, record({ id: NEIGHBOUR, claim: 'The morning window is clear' }))
    seedDerivedIndexes()

    const before = areaIndexFiles()
    expect(before).toHaveLength(1)
    expect(readFileSync(join(corpusDir, before[0]), 'utf8')).toContain(`${SUBJECT}.md`)

    erase()

    const after = areaIndexFiles()
    expect(after).toEqual(before) // still there, because it still has a member
    const text = readFileSync(join(corpusDir, after[0]), 'utf8')
    expect(text).not.toContain(`${SUBJECT}.md`)
    expect(text).not.toContain('clears the evening backlog')
    expect(text).toContain(`${NEIGHBOUR}.md`)
  })

  it('Test 5b: an area index the rebuild no longer produces is DELETED, not left holding the claim', () => {
    // the subject is the ONLY periphery note, so after the erase its area index
    // has no members at all. A rebuild that only WRITES files would leave the
    // orphan on disk still carrying the erased claim — a surviving copy on a
    // derived index, which is the exact failure ACC-3 exists to catch.
    seed(corpusDir, record())
    seed(corpusDir, record({ id: NEIGHBOUR, context_priority: 'always', claim: 'The morning window is clear' }))
    seedDerivedIndexes()

    const before = areaIndexFiles()
    expect(before).toHaveLength(1)
    const orphanPath = join(corpusDir, before[0])
    expect(readFileSync(orphanPath, 'utf8')).toContain('clears the evening backlog')

    const res = erase()

    expect(existsSync(orphanPath)).toBe(false)
    expect(areaIndexFiles()).toEqual([])
    expect(res.changed).toContain(orphanPath)
    // and the surface reports the deletion rather than only the writes
    expect(res.surfaces.find((s: any) => s.surface === 'area-indexes').removed).toContain(orphanPath)
  })

  it('Test 6: the lexical index no longer returns the erased record', () => {
    seed(corpusDir, record())
    seed(corpusDir, record({ id: NEIGHBOUR, claim: 'The morning window is clear' }))
    const built = seedDerivedIndexes()
    if (built.engine === LEXICAL_ENGINES.UNAVAILABLE) return // honest skip: no engine on this machine

    const hitsBefore = queryLexical({ query: SUBJECT, dbPath }).results.map((r: any) => r.id)
    expect(hitsBefore).toContain(`${SUBJECT}.md`)

    erase()

    const hitsAfter = queryLexical({ query: SUBJECT, dbPath }).results.map((r: any) => r.id)
    expect(hitsAfter).not.toContain(`${SUBJECT}.md`)
    // and the index still answers about everything else
    expect(queryLexical({ query: NEIGHBOUR, dbPath }).results.map((r: any) => r.id)).toContain(`${NEIGHBOUR}.md`)
  })

  it('Test 7: after a successful erase, verifyErasure finds nothing on any surface', () => {
    seedEverySurface()
    seedDerivedIndexes()

    const before = verifyErasure({ id: SUBJECT, ...ctx() })
    expect(before.clean).toBe(false)
    expect(before.survivors.length).toBeGreaterThan(0)

    erase()

    const after = verifyErasure({ id: SUBJECT, ...ctx() })
    expect(after.clean).toBe(true)
    expect(after.survivors).toEqual([])
  })

  it('Test 8: the changed list enumerates what was actually removed and rebuilt', () => {
    seedEverySurface()
    seedDerivedIndexes()

    const res = erase()

    expect(res.changed).toContain(join(corpusDir, `${SUBJECT}.md`))
    expect(res.changed).toContain(join(draftsDir, `${SUBJECT}.md`))
    expect(res.changed).toContain(join(localDir, `${SUBJECT}.md`))
    expect(res.changed).toContain(join(corpusDir, 'MEMORY.md'))
    expect(res.action).toBe('erase')
    expect(res.id).toBe(SUBJECT)
  })
})

describe('the refusals — a delete that guessed would be unrecoverable', () => {
  it('Test 9: a record that does not exist is a REFUSAL naming the id, never a silent success', () => {
    seed(corpusDir, record({ id: NEIGHBOUR, claim: 'The morning window is clear' }))
    seedDerivedIndexes()

    const res = eraseRecord({ id: 'working-depot-scanner-no-such-record', ...ctx() })

    expect(res.applied).toBe(false)
    expect(res.refusal).toContain('working-depot-scanner-no-such-record')
    // and it changed nothing on the way to saying so
    expect(existsSync(join(corpusDir, `${NEIGHBOUR}.md`))).toBe(true)
    expect(res.changed).toEqual([])
  })

  it('Test 10: an empty id is a refusal, not a walk over every surface', () => {
    seedEverySurface()
    const res = eraseRecord({ id: '   ', ...ctx() })
    expect(res.applied).toBe(false)
    expect(String(res.refusal)).toMatch(/id/i)
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
  })
})

describe('a partial erasure is a failure, and it says which surface', () => {
  it('Test 11: an injected removal failure names the surface AND still enumerates what succeeded', () => {
    seedEverySurface()
    seedDerivedIndexes()

    const draftPath = join(draftsDir, `${SUBJECT}.md`)
    const fsImpl = {
      rmSync: (path: string, opts: any) => {
        if (String(path) === draftPath) throw new Error('EPERM: injected removal failure')
        rmSync(path, opts)
      },
    }

    const res = erase({ fsImpl })

    expect(res.applied).toBe(false)
    expect(JSON.stringify(res.failures)).toContain('drafts')
    // read back: the drafts copy really is still there — the failure is real
    expect(existsSync(draftPath)).toBe(true)
    // the surfaces that DID succeed stay knowable
    const corpus = res.surfaces.find((s: any) => s.surface === 'corpus')
    expect(corpus.removed).toContain(join(corpusDir, `${SUBJECT}.md`))
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(false)
    expect(existsSync(join(localDir, `${SUBJECT}.md`))).toBe(false)
  })

  it('Test 12: a surviving copy makes verifyErasure report unclean and name the surface', () => {
    seedEverySurface()
    seedDerivedIndexes()

    const draftPath = join(draftsDir, `${SUBJECT}.md`)
    erase({
      fsImpl: {
        rmSync: (path: string, opts: any) => {
          if (String(path) === draftPath) throw new Error('EPERM: injected removal failure')
          rmSync(path, opts)
        },
      },
    })

    const verified = verifyErasure({ id: SUBJECT, ...ctx() })
    expect(verified.clean).toBe(false)
    expect(verified.survivors).toContain(draftPath)
    expect(verified.surfaces.find((s: any) => s.surface === 'drafts').survivors).toContain(draftPath)
  })
})

describe('the journal keeps the evidence the record no longer is', () => {
  it('Test 13: gains an erasure event carrying the id and the surfaces cleared', () => {
    seedEverySurface()
    seedDerivedIndexes()

    erase()

    const events = journalEvents()
    const erasure = events.filter((e) => JSON.stringify(e.detail ?? {}).includes('erase'))
    expect(erasure.length).toBe(1)
    expect(erasure[0].detail.id).toBe(SUBJECT)
    expect(erasure[0].detail.action).toBe('erase')
    expect(Array.isArray(erasure[0].detail.surfaces)).toBe(true)
    expect(erasure[0].detail.surfaces).toContain('corpus')
  })

  it('Test 14: no prior journal line is altered or removed — the earlier bytes are identical', () => {
    seedEverySurface()
    seedDerivedIndexes()

    appendEvent(
      { type: 'memory-write', scope: 'memory-corpus', detail: { stage: 'persist', id: SUBJECT } },
      { terminalId: 'test-erase', journalDir, now: '2026-08-03T09:00:00.000Z' },
    )
    const before = journalRaw()
    expect(before.trim().split('\n')).toHaveLength(1)

    erase()

    const after = journalRaw()
    expect(after.startsWith(before)).toBe(true)
    expect(after.trim().split('\n')).toHaveLength(2)
    // the pre-existing line, byte for byte
    expect(after.split('\n')[0]).toBe(before.split('\n')[0])
  })

  it('Test 15: the journal keeps a POINTER, never the claim text it just destroyed', () => {
    seedEverySurface()
    seedDerivedIndexes()

    erase()

    expect(journalRaw()).not.toContain('clears the evening backlog')
    expect(journalRaw()).toContain(SUBJECT)
  })
})

describe('links the erase did not author', () => {
  it('Test 16: an episode pointing at the erased record is reported dangling, not repointed and not deleted', () => {
    seedEverySurface()
    seed(episodesDir, {
      id: 'depot-scanner-night-drill',
      schema_version: '2',
      status: 'archived',
      memory_type: 'episodic',
      superseded_by: SUBJECT,
      recorded_at: '2026-07-30',
      sensitivity: 'internal',
      language: 'en',
    })
    seedDerivedIndexes()

    const episodePath = join(episodesDir, 'depot-scanner-night-drill.md')
    const before = readFileSync(episodePath, 'utf8')

    const res = erase()

    expect(res.applied).toBe(true)
    expect(JSON.stringify(res.dangling)).toContain('depot-scanner-night-drill')
    expect(JSON.stringify(res.dangling)).toContain('superseded_by')
    // neither repointed nor deleted — canon §13 item 2 forbids rewriting a record
    // this operation did not author
    expect(existsSync(episodePath)).toBe(true)
    expect(readFileSync(episodePath, 'utf8')).toBe(before)
    expect(parseNote(readFileSync(episodePath, 'utf8'), { file: episodePath }).frontmatter.superseded_by).toBe(SUBJECT)
  })

  it('Test 17: a surviving corpus record whose derived_from named the erased record is reported dangling too', () => {
    seedEverySurface()
    seed(corpusDir, record({ id: NEIGHBOUR, claim: 'The morning window is clear', derived_from: SUBJECT }))
    seedDerivedIndexes()

    const res = erase()

    expect(JSON.stringify(res.dangling)).toContain(NEIGHBOUR)
    expect(JSON.stringify(res.dangling)).toContain('derived_from')
    expect(existsSync(join(corpusDir, `${NEIGHBOUR}.md`))).toBe(true)
    expect(parseNote(readFileSync(join(corpusDir, `${NEIGHBOUR}.md`), 'utf8'), { file: 'x' }).frontmatter.derived_from).toBe(SUBJECT)
  })

  it('Test 17b: a typed links edge pointing at the erased record is reported dangling — not only the five pointer fields', () => {
    // schema v2's edge vocabulary shipped in the SAME phase as erase; a report
    // that read only the old pointer fields would call this corpus clean.
    seedEverySurface()
    seed(corpusDir, record({ id: NEIGHBOUR, claim: 'The morning window is clear', links: [{ type: 'supports', ref: SUBJECT }] }))
    seedDerivedIndexes()

    const res = erase()

    expect(res.applied).toBe(true)
    expect(JSON.stringify(res.dangling)).toContain(NEIGHBOUR)
    expect(JSON.stringify(res.dangling)).toContain('links[0]')
    // the pointing record is untouched — reported, never rewritten
    const fm = parseNote(readFileSync(join(corpusDir, `${NEIGHBOUR}.md`), 'utf8'), { file: 'x' }).frontmatter as any
    expect(fm.links).toEqual([{ type: 'supports', ref: SUBJECT }])
  })
})

describe('a record id that is a suffix of a survivor id', () => {
  it('Test 17c: erasing the short id does not read the long survivor as its own copy', () => {
    // `evening-window` is a strict suffix of the SUBJECT id. A substring match
    // on `<id>.md` would find `…scanner-evening-window.md` in the rebuilt
    // indexes, report a false survivor, and fail a fully successful erase —
    // unrecoverably, because re-running can never clear the neighbour's line.
    const SHORT = 'evening-window'
    // the long survivor sits in CORE, so the rebuilt MEMORY.md quotes its
    // filename — the exact line a substring match would read as the short id's
    seed(corpusDir, record({ context_priority: 'always' }))
    seed(corpusDir, record({ id: SHORT, claim: 'The short evening window closes at nine' }))
    seedDerivedIndexes()

    const res = eraseRecord({ id: SHORT, ...ctx() })

    expect(res.failures).toEqual([])
    expect(res.applied).toBe(true)
    expect(existsSync(join(corpusDir, `${SHORT}.md`))).toBe(false)
    // the long neighbour survives, catalogued, and is not read as a copy
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
    const index = readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')
    expect(index).toContain(`${SUBJECT}.md`)
  })
})

describe('git history — the one surface this cannot reach, said out loud', () => {
  it('Test 18: the result names history as an untouched, known exception', () => {
    seedEverySurface()
    seedDerivedIndexes()

    const res = erase()

    expect(res.history.touched).toBe(false)
    expect(String(res.history.note)).toMatch(/histor/i)
    expect(String(res.history.note)).toMatch(/clone|коммит|commit/i)
    // the same honest line rides on the verification, not only on the removal
    expect(verifyErasure({ id: SUBJECT, ...ctx() }).history.touched).toBe(false)
  })

})

describe('the lifecycle stops refusing — erase is the fifth action', () => {
  /** applyLifecycle against the fixture, with every store the erase must reach. */
  function lc(extra: Record<string, unknown> = {}) {
    return applyLifecycle({ id: SUBJECT, action: 'erase', ...ctx(), ...extra })
  }

  it('Test 20: LIFECYCLE_ACTIONS performs five actions, and erase is one of them', () => {
    expect(LIFECYCLE_ACTIONS).toEqual(['supersede', 'revoke', 'expire', 'archive', 'erase'])
    expect(LIFECYCLE_ACTIONS).toHaveLength(5)
    expect(Object.isFrozen(LIFECYCLE_ACTIONS)).toBe(true)
  })

  it('Test 21: erase returns an APPLIED result in the same shape a revoke returns', () => {
    seedEverySurface()
    seed(corpusDir, record({ id: NEIGHBOUR, claim: 'The morning window is clear' }))
    seedDerivedIndexes()

    const revoked = applyLifecycle({ ...ctx(), id: NEIGHBOUR, action: 'revoke', reason: 'superseded by a measurement' })
    expect(revoked.applied).toBe(true)

    const erased = lc()

    expect(erased.applied).toBe(true)
    expect(erased.action).toBe('erase')
    expect(erased.id).toBe(SUBJECT)
    expect(erased.changed.length).toBeGreaterThan(0)
    // ONE contract: every key the other four return is present on the destructive path
    for (const key of Object.keys(revoked)) expect(erased).toHaveProperty(key)
    // read back — the record really is gone
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(false)
  })

  it('Test 22: the erase refusal is gone from the reachable path, and nothing points at a policy any more', () => {
    seedEverySurface()
    seedDerivedIndexes()

    const res = lc()

    expect(res.refusal).toBeUndefined()
    expect(JSON.stringify(res)).not.toMatch(/refused by policy/)
    expect(readFileSync(join(LIB, 'write-pipeline.mjs'), 'utf8')).not.toMatch(/ERASE_REFUSAL/)
  })

  it('Test 23: an unknown action still returns the unknown-action refusal naming the legal set', () => {
    seedEverySurface()
    seedDerivedIndexes()

    const res = applyLifecycle({ ...ctx(), id: SUBJECT, action: 'obliterate' })

    expect(res.applied).toBe(false)
    expect(res.refusal).toMatch(/obliterate/)
    for (const action of LIFECYCLE_ACTIONS) expect(res.refusal).toContain(action)
    // and the guard changed nothing
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
  })

  it('Test 24: a shared record erases from the corpus, verified on its own surface', () => {
    seed(corpusDir, record())
    seedDerivedIndexes()

    const res = lc()

    expect(res.applied).toBe(true)
    expect(res.storage_class).toBe('shared')
    expect(res.surfaces.find((s: any) => s.surface === 'corpus').outcome).toBe('cleared')
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(false)
    expect(verifyErasure({ id: SUBJECT, ...ctx() }).clean).toBe(true)
  })

  it('Test 25: a this-machine-only record erases from the LOCAL store, and the corpus is not reported broken for lacking it', () => {
    seed(localDir, record({ sensitivity: 'sensitive' }))
    seed(corpusDir, record({ id: NEIGHBOUR, claim: 'The morning window is clear' }))
    seedDerivedIndexes()

    const res = lc()

    expect(res.applied).toBe(true)
    expect(res.storage_class).toBe('this-machine-only')
    expect(existsSync(join(localDir, `${SUBJECT}.md`))).toBe(false)
    expect(res.surfaces.find((s: any) => s.surface === 'local-store').outcome).toBe('cleared')
    // routing, not a walk over everything: the corpus was never this record's home
    expect(res.surfaces.find((s: any) => s.surface === 'corpus').applicable).toBe(false)
    expect(res.failures).toEqual([])
    // the corpus record that was never the subject is untouched
    expect(existsSync(join(corpusDir, `${NEIGHBOUR}.md`))).toBe(true)
    expect(verifyErasure({ id: SUBJECT, ...ctx() }).clean).toBe(true)
  })

  it('Test 26: a failed erase surfaces through applyLifecycle as a FAILURE, never as an applied result', () => {
    seedEverySurface()
    seedDerivedIndexes()

    const draftPath = join(draftsDir, `${SUBJECT}.md`)
    const res = lc({
      fsImpl: {
        rmSync: (path: string, opts: any) => {
          if (String(path) === draftPath) throw new Error('EPERM: injected removal failure')
          rmSync(path, opts)
        },
      },
    })

    expect(res.applied).toBe(false)
    expect(String(res.refusal)).toContain('drafts')
    expect(JSON.stringify(res.failures)).toContain('drafts')
    expect(existsSync(draftPath)).toBe(true)
  })

  it('Test 27: the four pre-existing actions are unchanged — a revoke still transitions and never deletes', () => {
    seed(corpusDir, record())
    seedDerivedIndexes()

    const res = applyLifecycle({ ...ctx(), id: SUBJECT, action: 'revoke', reason: 'the depot changed its scanner' })

    expect(res.applied).toBe(true)
    expect(res.status).toBe('revoked')
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
    expect(parseNote(readFileSync(join(corpusDir, `${SUBJECT}.md`), 'utf8'), { file: 'x' }).frontmatter.status).toBe('revoked')
  })
})

// ── Added 2026-08-05 ────────────────────────────────────────────────────────
//
// The episode archive is deliberately NOT an erase surface: the command is
// scoped to the ACTIVE corpus, the working tree and every derived index, and an
// episode is a different asset class — "what happened" rather than "what is
// true". Normally the question cannot arise, because migrate-v1-v2 writes the
// extracted claim as `<stem>-claim` while the episode keeps `<stem>`.
//
// Nothing in the id law FORBIDS the collision, though, and on a collision the
// episode would hold a copy of the erased content that no surface reports —
// a copy surviving a "physical removal" without being named. Option (a),
// erasing episodes too, was NOT chosen: it is a strictly larger promise than
// the one that was approved. What ships is option (b), the REFUSAL — erase
// declines while the collision exists, names the file, and the operator decides.

describe('an episode that shares the erased id — the refusal', () => {
  it('Test 29: erase REFUSES while episodes/<id>.md exists, names the file, and deletes nothing', () => {
    seedEverySurface()
    // the collision: an episode carrying the SAME stem as the corpus record
    seed(episodesDir, {
      id: SUBJECT,
      schema_version: '2',
      status: 'archived',
      memory_type: 'episodic',
      recorded_at: '2026-07-30',
      sensitivity: 'internal',
      language: 'en',
    })
    seedDerivedIndexes()
    const episodePath = join(episodesDir, `${SUBJECT}.md`)
    const episodeBefore = readFileSync(episodePath, 'utf8')
    const indexBefore = readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')

    const res = erase()

    // fail-closed: a refusal, not a partial success with a warning attached
    expect(res.applied).toBe(false)
    expect(res.refusal).toBeTruthy()
    expect(res.refusal).toContain(`${SUBJECT}.md`)
    expect(res.refusal).toContain('episode')
    expect(res.changed).toEqual([])
    // NOTHING was removed — every copy surface still holds the record, read back
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(true)
    expect(existsSync(join(draftsDir, `${SUBJECT}.md`))).toBe(true)
    expect(existsSync(join(localDir, `${SUBJECT}.md`))).toBe(true)
    // the derived index was not rebuilt and the episode was not touched
    expect(readFileSync(join(corpusDir, 'MEMORY.md'), 'utf8')).toBe(indexBefore)
    expect(readFileSync(episodePath, 'utf8')).toBe(episodeBefore)
  })

  it('Test 30: the refusal is a GATE, not a wall — once the operator resolves the episode, the same erase completes', () => {
    seedEverySurface()
    seed(episodesDir, {
      id: SUBJECT,
      schema_version: '2',
      status: 'archived',
      memory_type: 'episodic',
      recorded_at: '2026-07-30',
      sensitivity: 'internal',
      language: 'en',
    })
    seedDerivedIndexes()

    expect(erase().applied).toBe(false)

    // the operator decides what happens to the history — here, they move it out
    rmSync(join(episodesDir, `${SUBJECT}.md`), { force: true })

    const res = erase()
    expect(res.failures).toEqual([])
    expect(res.applied).toBe(true)
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(false)
  })

  it('Test 31: an episode with a DIFFERENT id does not trigger the refusal — the normal case still erases', () => {
    // The collision is the hole; the ordinary `<stem>` / `<stem>-claim` pairing
    // is not, and a refusal that fired on it would make erase unusable.
    seedEverySurface()
    seed(episodesDir, {
      id: 'depot-scanner-night-drill',
      schema_version: '2',
      status: 'archived',
      memory_type: 'episodic',
      recorded_at: '2026-07-30',
      sensitivity: 'internal',
      language: 'en',
    })
    seedDerivedIndexes()

    const res = erase()

    expect(res.applied).toBe(true)
    expect(res.refusal).toBeUndefined()
    expect(existsSync(join(corpusDir, `${SUBJECT}.md`))).toBe(false)
    expect(existsSync(join(episodesDir, 'depot-scanner-night-drill.md'))).toBe(true)
  })

  it('Test 32: verifyErasure is untouched by the refusal — a read-only check never declines to look', () => {
    seedEverySurface()
    seed(episodesDir, {
      id: SUBJECT,
      schema_version: '2',
      status: 'archived',
      memory_type: 'episodic',
      recorded_at: '2026-07-30',
      sensitivity: 'internal',
      language: 'en',
    })

    const res = verifyErasure({ id: SUBJECT, ...ctx() })

    expect(res.refusal).toBeUndefined()
    expect(res.clean).toBe(false)
    expect(res.survivors.length).toBeGreaterThan(0)
  })
})

describe('the module source — assertions that read the file, not the docs', () => {
  it('Test 28: no code path in erase.mjs can execute a git command', () => {
    const source = readFileSync(join(LIB, 'erase.mjs'), 'utf8')
    expect(source).not.toMatch(/child_process/)
    expect(source).not.toMatch(/execSync|spawnSync|execFileSync/)
    // and no transitive import brings one in either
    for (const dep of ['generator.mjs', 'fts-index.mjs', 'journal.mjs', 'fs-atomics.mjs', 'local-store.mjs', 'episodes.mjs', 'schema-v2.mjs', 'frontmatter.mjs']) {
      expect(readFileSync(join(LIB, dep), 'utf8')).not.toMatch(/child_process/)
    }
  })
})
