/**
 * Tests for scripts/sma/lib/episodes.mjs — the episode layer — and for the
 * `episodes/` branch of scripts/sma/lib/memory-scaffold.mjs.
 *
 * An EPISODE is history: what happened, once, in as many sentences as it took.
 * It lives beside the corpus in `.claude/memory/episodes/`, it is a normal
 * frontmatter'd markdown file, and it is deliberately NOT subject to the
 * one-claim-per-record law that governs reviewed records. It is also invisible
 * to the default context load — not by a filter anyone can forget to apply, but
 * by living one directory down from a walk that never descends.
 *
 * What these tests pin:
 *   - readEpisodes fails SOFT on an absent directory ([]) and LOUD on a
 *     malformed record (an unreadable episode is never silently skipped).
 *   - writeEpisode NEVER clobbers: a second write of the same id without an
 *     explicit allowUpdate leaves the bytes on disk untouched and says so.
 *   - the id law (id === filename stem) is enforced at the write path, and an
 *     id can never address a file outside episodes/.
 *   - episodeArchiveFields is the minimal field set an archived record carries,
 *     and such a record round-trips through the shared parser byte-for-byte.
 *   - a fresh scaffold ships an EMPTY episodes/ directory, and a scaffold over a
 *     live corpus keeps every byte of it (the data-loss regression).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readEpisodes,
  writeEpisode,
  episodeArchiveFields,
  linkClaim,
  EPISODES_DIRNAME,
} from '../lib/episodes.mjs'
import { parseNote, serializeNote } from '../lib/frontmatter.mjs'
import { scaffoldMemory } from '../lib/memory-scaffold.mjs'

let corpusDir: string

/** The minimal archive record the migration batch will write, field by field. */
const ARCHIVE_FM = {
  id: 'episode-2026-07-21-release-night',
  schema_version: '2',
  memory_type: 'episodic',
  status: 'archived',
  supersedes: 'reference_old_release.md',
  superseded_by: 'reference_new_release.md',
  superseded_at: '2026-07-22',
  observed_at: '2026-07-21',
  recorded_at: '2026-07-22',
  valid_from: '2026-07-21',
  valid_until: '2026-08-21',
  sensitivity: 'internal',
  language: 'ru',
}

/** An episode body carrying SEVERAL claims — legal here, illegal in a record. */
const MULTI_CLAIM_BODY = `
Ночь релиза, три отдельных факта в одном рассказе:

- сьют прогнан дважды, оба раза зелёный;
- скан утечек дал ноль совпадений;
- тег и релиз созданы после пуша, не до.
`

function episodePath(id: string) {
  return join(corpusDir, EPISODES_DIRNAME, `${id}.md`)
}

beforeEach(() => {
  corpusDir = mkdtempSync(join(tmpdir(), 'sma-episodes-'))
})

afterEach(() => {
  rmSync(corpusDir, { recursive: true, force: true, maxRetries: 3 })
})

// ── readEpisodes ────────────────────────────────────────────────────────────

describe('episodes.mjs — readEpisodes', () => {
  it('returns [] for a corpus that has no episodes/ directory at all (ENOENT is fail-soft)', () => {
    expect(existsSync(join(corpusDir, EPISODES_DIRNAME))).toBe(false)
    expect(readEpisodes({ corpusDir })).toEqual([])
  })

  it('returns [] for an episodes/ directory holding only its .gitkeep placeholder', () => {
    mkdirSync(join(corpusDir, EPISODES_DIRNAME), { recursive: true })
    writeFileSync(join(corpusDir, EPISODES_DIRNAME, '.gitkeep'), '', 'utf8')
    expect(readEpisodes({ corpusDir })).toEqual([])
  })

  it('reads every episode in name order, returning {file, id, frontmatter, body}', () => {
    writeEpisode({ corpusDir, id: 'episode-b', frontmatter: { ...ARCHIVE_FM, id: undefined }, body: 'B\n' })
    writeEpisode({ corpusDir, id: 'episode-a', frontmatter: { ...ARCHIVE_FM, id: undefined }, body: 'A\n' })
    // Neighbours that are not episodes must be ignored, not mis-parsed.
    writeFileSync(join(corpusDir, EPISODES_DIRNAME, '.gitkeep'), '', 'utf8')
    writeFileSync(join(corpusDir, EPISODES_DIRNAME, 'notes.txt'), 'not markdown', 'utf8')
    mkdirSync(join(corpusDir, EPISODES_DIRNAME, 'nested.md'), { recursive: true })

    const eps = readEpisodes({ corpusDir })
    expect(eps.map((e: { file: string }) => e.file)).toEqual(['episode-a.md', 'episode-b.md'])
    expect(eps[0].id).toBe('episode-a')
    expect(eps[0].frontmatter.memory_type).toBe('episodic')
    expect(eps[0].frontmatter.schema_version).toBe('2')
    expect(eps[0].body).toBe('A\n')
  })

  it('throws, naming the file, when an episode carries an unreadable record (never a silent skip)', () => {
    mkdirSync(join(corpusDir, EPISODES_DIRNAME), { recursive: true })
    writeFileSync(episodePath('broken'), '---\nschema_version: 3\nid: broken\n---\n\nfuture\n', 'utf8')
    expect(() => readEpisodes({ corpusDir })).toThrow(/broken\.md/)
  })
})

// ── writeEpisode ────────────────────────────────────────────────────────────

describe('episodes.mjs — writeEpisode', () => {
  it('creates episodes/<id>.md as a schema-v2 record with the minimal archive fields', () => {
    const res = writeEpisode({
      corpusDir,
      id: ARCHIVE_FM.id,
      frontmatter: { ...ARCHIVE_FM, id: undefined },
      body: MULTI_CLAIM_BODY,
    })
    expect(res.created).toBe(true)
    expect(res.written).toBe(true)
    expect(res.path).toBe(episodePath(ARCHIVE_FM.id))

    const parsed = parseNote(readFileSync(res.path, 'utf8'), { file: `${ARCHIVE_FM.id}.md` })
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.frontmatter!.id).toBe(ARCHIVE_FM.id)
    expect(parsed.frontmatter!.memory_type).toBe('episodic')
    for (const field of episodeArchiveFields) {
      expect(Object.keys(parsed.frontmatter!)).toContain(field)
    }
  })

  it('keeps a MANY-claim body verbatim — the one-claim law does not reach episodes', () => {
    const res = writeEpisode({
      corpusDir,
      id: 'episode-multi',
      frontmatter: { ...ARCHIVE_FM, id: undefined },
      body: MULTI_CLAIM_BODY,
    })
    expect(parseNote(readFileSync(res.path, 'utf8'), { file: 'episode-multi.md' }).body).toBe(MULTI_CLAIM_BODY)
  })

  it('NEVER clobbers: a second write of the same id leaves the bytes untouched and reports it', () => {
    const first = writeEpisode({ corpusDir, id: 'episode-once', frontmatter: { ...ARCHIVE_FM, id: undefined }, body: 'original\n' })
    const bytesBefore = readFileSync(first.path, 'utf8')

    const second = writeEpisode({ corpusDir, id: 'episode-once', frontmatter: { ...ARCHIVE_FM, id: undefined }, body: 'REWRITTEN\n' })
    expect(second.created).toBe(false)
    expect(second.written).toBe(false)
    expect(readFileSync(first.path, 'utf8')).toBe(bytesBefore)
  })

  it('rewrites only when the caller asks out loud (allowUpdate), and says the file was not created', () => {
    const first = writeEpisode({ corpusDir, id: 'episode-once', frontmatter: { ...ARCHIVE_FM, id: undefined }, body: 'original\n' })
    const bytesBefore = readFileSync(first.path, 'utf8')

    const update = writeEpisode({
      corpusDir,
      id: 'episode-once',
      frontmatter: { ...ARCHIVE_FM, id: undefined },
      body: 'REWRITTEN\n',
      allowUpdate: true,
    })
    expect(update.created).toBe(false)
    expect(update.written).toBe(true)
    expect(readFileSync(first.path, 'utf8')).not.toBe(bytesBefore)
  })

  it('enforces the id law: a frontmatter id disagreeing with the filename stem is refused', () => {
    expect(() =>
      writeEpisode({ corpusDir, id: 'episode-a', frontmatter: { ...ARCHIVE_FM, id: 'episode-b' }, body: 'x\n' }),
    ).toThrow(/id/)
    expect(existsSync(episodePath('episode-a'))).toBe(false)
  })

  it('refuses an id that could address a file outside episodes/', () => {
    for (const id of ['../escape', 'sub/dir', '..', '.hidden', 'has space']) {
      expect(() => writeEpisode({ corpusDir, id, frontmatter: { ...ARCHIVE_FM, id: undefined }, body: 'x\n' })).toThrow()
    }
    expect(existsSync(join(corpusDir, 'escape.md'))).toBe(false)
  })

  it('refuses a record that is not episodic, or whose status is outside the closed vocabulary', () => {
    expect(() =>
      writeEpisode({ corpusDir, id: 'episode-x', frontmatter: { ...ARCHIVE_FM, id: undefined, memory_type: 'semantic' }, body: 'x\n' }),
    ).toThrow(/memory_type/)
    expect(() =>
      writeEpisode({ corpusDir, id: 'episode-x', frontmatter: { ...ARCHIVE_FM, id: undefined, status: 'retired' }, body: 'x\n' }),
    ).toThrow(/status/)
  })

  it('refuses a record missing a field the archive schema requires, naming every one of them', () => {
    let msg = ''
    try {
      writeEpisode({ corpusDir, id: 'episode-thin', frontmatter: { status: 'archived' }, body: 'x\n' })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/language/)
    expect(msg).toMatch(/sensitivity/)
    expect(msg).toMatch(/recorded_at/)
    expect(existsSync(episodePath('episode-thin'))).toBe(false)
  })
})

// ── the archive schema ──────────────────────────────────────────────────────

describe('episodes.mjs — episodeArchiveFields', () => {
  it('is the minimal archive field set, exactly and in order', () => {
    expect([...episodeArchiveFields]).toEqual([
      'id',
      'schema_version',
      'memory_type',
      'status',
      'supersedes',
      'superseded_by',
      'superseded_at',
      'observed_at',
      'recorded_at',
      'valid_from',
      'valid_until',
      'sensitivity',
      'language',
    ])
  })

  it('round-trips an archive episode through the shared parser byte-for-byte', () => {
    const res = writeEpisode({
      corpusDir,
      id: ARCHIVE_FM.id,
      frontmatter: { ...ARCHIVE_FM, id: undefined },
      body: MULTI_CLAIM_BODY,
    })
    const onDisk = readFileSync(res.path, 'utf8')
    const parsed = parseNote(onDisk, { file: `${ARCHIVE_FM.id}.md` })
    expect(serializeNote(parsed)).toBe(onDisk)
  })
})

// ── the claim -> episode link law ───────────────────────────────────────────

describe('episodes.mjs — linkClaim (the derived_from law)', () => {
  it('stamps a reviewed claim with a SCALAR derived_from naming the episode it came from', () => {
    const linked = linkClaim({ id: 'decision-release-gate', claim: 'the suite runs twice before a push' }, 'episode-2026-07-21-release-night')
    expect(linked.derived_from).toBe('episode-2026-07-21-release-night')
    expect(Array.isArray(linked.derived_from)).toBe(false)
  })

  it('does not mutate the caller\'s frontmatter object', () => {
    const original = { id: 'decision-release-gate' }
    linkClaim(original, 'episode-a')
    expect('derived_from' in original).toBe(false)
  })

  it('is idempotent for the same episode and refuses to silently re-point at another', () => {
    const once = linkClaim({ id: 'decision-x' }, 'episode-a')
    expect(linkClaim(once, 'episode-a').derived_from).toBe('episode-a')
    expect(() => linkClaim(once, 'episode-b')).toThrow(/derived_from/)
  })

  it('refuses an episode id that is not a legal episode id', () => {
    expect(() => linkClaim({ id: 'decision-x' }, '../escape')).toThrow()
    expect(() => linkClaim({ id: 'decision-x' }, '')).toThrow()
  })
})

// ── the scaffold branch ─────────────────────────────────────────────────────

describe('memory-scaffold.mjs — the episodes/ branch', () => {
  const execGit = () => 'abc1234\n'

  it('a fresh install materializes an EMPTY episodes/ directory (placeholder only, zero notes)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sma-scaffold-'))
    try {
      const res = await scaffoldMemory({ projectDir, execGit })
      const episodesDir = join(projectDir, '.claude', 'memory', EPISODES_DIRNAME)
      expect(existsSync(join(episodesDir, '.gitkeep'))).toBe(true)
      expect(res.created).toContain('episodes/.gitkeep')
      // The architecture ships; the history does not. Zero episode files.
      expect(readdirSync(episodesDir).filter((f) => f.endsWith('.md'))).toEqual([])
      expect(res.notes).toBe(0)
    } finally {
      rmSync(projectDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('over a LIVE corpus: every byte of an existing episode survives, and the scaffold reports it kept', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sma-scaffold-live-'))
    try {
      const memoryDir = join(projectDir, '.claude', 'memory')
      const episodesDir = join(memoryDir, EPISODES_DIRNAME)
      mkdirSync(episodesDir, { recursive: true })
      const mine = join(episodesDir, 'episode-mine.md')
      const body = '---\nid: episode-mine\nschema_version: 2\nmemory_type: episodic\n---\n\nMy own history.\n'
      writeFileSync(mine, body, 'utf8')

      const res = await scaffoldMemory({ projectDir, execGit })

      expect(readFileSync(mine, 'utf8')).toBe(body)
      expect(res.kept).toContain('episodes/')
      expect(res.created).not.toContain('episodes/.gitkeep')
    } finally {
      rmSync(projectDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
