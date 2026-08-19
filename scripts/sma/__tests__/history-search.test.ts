/**
 * Tests for the search across the four corpora a working session leaves behind:
 * the coordination journal, the plan-execution journal, the vendor's session
 * transcripts and the lesson corpus.
 *
 * WHY EACH CASE EXISTS — every one of them is a defect that has a name:
 *
 *   - Case 1 (the wire): a search that reads ONE book and calls itself a history
 *     search is the failure this file was written to make impossible. The fixture
 *     puts the same word in the journal AND in a transcript, and the assertion is
 *     that ONE run brings back both, each labelled with where it came from. A test
 *     that only proves "the scanner can scan" would pass on a search wired to a
 *     single corpus.
 *   - Case 2 (lesson bodies): the memory layer's own lexical index deliberately
 *     indexes the AXIS of a note and not its body. History is a different question
 *     with a different answer: a word that lives only in the prose of a lesson has
 *     to be findable here, and the fixture note carries the word in its body and
 *     in none of its fields.
 *   - Case 3 (secrets): transcripts hold everything that was ever printed in a
 *     session, credentials included. A search output is a new way to spill them,
 *     so a credential-shaped token in the fixture transcript must never come back
 *     in the clear — and the surrounding line must still come back, because
 *     dropping the whole line would be a search that hides history.
 *   - Case 4 (fail-open): the vendor's transcript directory does not exist on
 *     every machine. Its absence is an empty book, never an error, and the other
 *     three corpora are still searched.
 *   - Case 5 (early stop): the transcripts on a working machine run to hundreds of
 *     megabytes. A limit that is applied only when printing would have read all of
 *     it first. The counter of opened files is injected, so the assertion is about
 *     what the scan DID, not about what it returned.
 *   - Case 6 (no whole-file reads): the guard behind case 5 — the module must not
 *     carry a whole-file read on the transcript path at all.
 *   - Case 7 (the verb): the CLI verb calls the module and prints sources; a bare
 *     invocation prints usage instead of a stack trace.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { searchHistory, maskSecrets, HISTORY_SOURCES } from '../lib/history-search.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'cli.mjs')
const MODULE = join(HERE, '..', 'lib', 'history-search.mjs')

/**
 * A credential-shaped token assembled at runtime. Written as one literal it would
 * be a credential-shaped string sitting in the tree for every future secret scan to
 * trip over; assembled here it has the exact SHAPE under test and no literal.
 */
const FAKE_TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9j0'

/** The word planted in every corpus. Prose, not a symbol — the tokenizer sees both. */
const WORD = 'пеликан'

let root: string

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-history-'))

  // ── the coordination journal: one terminal file, one event carrying the word
  const journalDir = join(dir, 'journal')
  mkdirSync(journalDir, { recursive: true })
  writeFileSync(
    join(journalDir, 'a-1001.jsonl'),
    JSON.stringify({ ts: '2026-01-02T03:04:05.000Z', terminal: 'a-1001', seq: 1, type: 'claim', scope: `${WORD}-scope` }) +
      '\n' +
      JSON.stringify({ ts: '2026-01-02T03:05:05.000Z', terminal: 'a-1001', seq: 2, type: 'release', scope: 'unrelated' }) +
      '\n',
    'utf8',
  )

  // ── the plan-execution journal: one plan file
  const execDir = join(dir, 'exec')
  mkdirSync(execDir, { recursive: true })
  writeFileSync(
    join(execDir, '99-01.jsonl'),
    JSON.stringify({ ts: '2026-01-03T00:00:00.000Z', task: 1, event: 'task_complete', file: `${WORD}.mjs` }) + '\n',
    'utf8',
  )

  // ── the lesson corpus: the word lives ONLY in the body prose
  const corpusDir = join(dir, 'memory')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(
    join(corpusDir, 'a-lesson.md'),
    `---\ndescription: a lesson about nothing in particular\nkind: reference\ntags: [tech]\nimportance: 4\nrecorded_at: 2026-01-04\n---\nThe body says ${WORD} and no field does.\n`,
    'utf8',
  )

  // ── the vendor transcripts: the word, and on another line a credential
  const logsDir = join(dir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  writeFileSync(
    join(logsDir, 'session-a.jsonl'),
    JSON.stringify({ timestamp: '2026-01-05T06:07:08.000Z', text: `we discussed the ${WORD} plan` }) +
      '\n' +
      JSON.stringify({ timestamp: '2026-01-05T06:08:08.000Z', text: `the ${WORD} deploy used ${FAKE_TOKEN} as the token` }) +
      '\n',
    'utf8',
  )

  return dir
}

const journalDir = () => join(root, 'journal')
const execDir = () => join(root, 'exec')
const corpusDir = () => join(root, 'memory')
const logsDir = () => join(root, 'logs')

/** Every call in this file injects all four roots — the real history is never read. */
function run(over: Record<string, unknown> = {}) {
  return searchHistory({
    query: WORD,
    journalDir: journalDir(),
    execDir: execDir(),
    corpusDir: corpusDir(),
    logsDir: logsDir(),
    env: {},
    ...over,
  })
}

beforeEach(() => {
  root = seed()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('searchHistory — one run, four books', () => {
  it('brings back hits from the journal AND the transcripts in the SAME run, each naming its source', async () => {
    const res = await run()
    const sources = new Set(res.hits.map((h: any) => h.source))
    // The wire, stated as an assertion: one corpus is not a history search.
    expect(sources.has('journal')).toBe(true)
    expect(sources.has('transcript')).toBe(true)

    const fromJournal = res.hits.find((h: any) => h.source === 'journal')
    expect(fromJournal.file).toContain('a-1001.jsonl')
    expect(fromJournal.ts).toBe('2026-01-02T03:04:05.000Z')
    expect(fromJournal.fragment).toContain(WORD)

    const fromTranscript = res.hits.find((h: any) => h.source === 'transcript')
    expect(fromTranscript.file).toContain('session-a.jsonl')
    expect(fromTranscript.ts).toBe('2026-01-05T06:07:08.000Z')
    expect(fromTranscript.fragment).toContain(WORD)

    // and the execution journal is the third book, not an afterthought
    expect(sources.has('exec')).toBe(true)
  })

  it('finds a word that lives only in the BODY of a lesson (the axis index cannot)', async () => {
    const res = await run()
    const lesson = res.hits.find((h: any) => h.source === 'lesson')
    expect(lesson).toBeDefined()
    expect(lesson.file).toContain('a-lesson.md')
    expect(lesson.fragment).toContain(WORD)
  })

  it('masks a credential-shaped token instead of printing it, and keeps the line', async () => {
    const res = await run()
    const all = JSON.stringify(res)
    expect(all).not.toContain(FAKE_TOKEN)
    // the line itself still comes back — a search that hides history is not a cure
    const carrying = res.hits.filter((h: any) => h.source === 'transcript' && h.fragment.includes('deploy'))
    expect(carrying.length).toBeGreaterThan(0)
    expect(carrying[0].fragment).not.toContain(FAKE_TOKEN)
  })

  it('treats a missing transcript directory as an empty book, not an error', async () => {
    const res = await run({ logsDir: join(root, 'no-such-dir') })
    expect(res.hits.some((h: any) => h.source === 'transcript')).toBe(false)
    // the other three books are still read
    expect(res.hits.some((h: any) => h.source === 'journal')).toBe(true)
    expect(res.hits.some((h: any) => h.source === 'lesson')).toBe(true)
  })

  it('stops opening transcript files once the limit is met, instead of reading them all', async () => {
    // twelve more transcript files, each carrying the word
    for (let i = 0; i < 12; i++) {
      writeFileSync(
        join(logsDir(), `session-b${i}.jsonl`),
        JSON.stringify({ timestamp: `2026-02-0${(i % 9) + 1}T00:00:00.000Z`, text: `${WORD} again` }) + '\n',
        'utf8',
      )
    }
    const openedAll: string[] = []
    const all = await run({ limit: 50, onOpen: (p: string, s: string) => { if (s === 'transcript') openedAll.push(p) } })

    const openedFew: string[] = []
    const few = await run({ limit: 1, onOpen: (p: string, s: string) => { if (s === 'transcript') openedFew.push(p) } })

    expect(openedAll.length).toBe(13)
    expect(openedFew.length).toBeLessThan(openedAll.length)
    expect(few.hits.filter((h: any) => h.source === 'transcript').length).toBe(1)
    expect(all.hits.filter((h: any) => h.source === 'transcript').length).toBeGreaterThan(1)
  })

  it('honours --source: asking for one book reads only that book', async () => {
    const res = await run({ sources: ['journal'] })
    expect(res.hits.length).toBeGreaterThan(0)
    expect(new Set(res.hits.map((h: any) => h.source))).toEqual(new Set(['journal']))
  })

  it('an honest empty result is a result, not a throw', async () => {
    const res = await run({ query: 'словокотороготочнонет' })
    expect(res.hits).toEqual([])
  })

  it('matches on TOKENS, not on a naive substring', async () => {
    // «пеликан» must not be found by «пели» — a substring search would find it
    const res = await run({ query: 'пели' })
    expect(res.hits).toEqual([])
  })
})

describe('the transcript path never reads a whole file into memory', () => {
  it('carries no readFileSync on the transcript scan', () => {
    const src = readFileSync(MODULE, 'utf8')
    // the transcript scanner is the streaming one; the guard is the import list
    expect(src).toContain('createReadStream')
    expect(src).toContain('readline')
    const scanner = src.slice(src.indexOf('function scanTranscripts'))
    expect(scanner).not.toContain('readFileSync')
  })
})

describe('maskSecrets', () => {
  it('replaces a credential-shaped run and leaves ordinary prose alone', () => {
    const out = maskSecrets(`the token is ${FAKE_TOKEN} ok`)
    expect(out).not.toContain(FAKE_TOKEN)
    expect(out).toContain('the token is')
    expect(out).toContain('ok')
  })
})

describe('the CLI verb', () => {
  function cli(args: string[]) {
    const res = spawnSync('node', [CLI, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        // journal/ and exec/ are derived from this root exactly as every other verb
        // derives them; the transcript dir has its own existing env override; the
        // lesson corpus is named by the SAME --corpus flag the memory verbs take.
        SMA_ROOT_OVERRIDE: root,
        SMA_SPEND_LOGS_DIR: logsDir(),
        NODE_OPTIONS: '--no-warnings',
      },
    })
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status ?? 1 }
  }

  it('prints hits with their sources and exits 0', () => {
    const res = cli(['history', 'search', WORD, '--corpus', corpusDir()])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('journal')
    expect(res.stdout).toContain('transcript')
    expect(res.stdout).toContain(WORD)
  })

  it('--json carries source, file, ts and fragment structurally', () => {
    const res = cli(['history', 'search', WORD, '--corpus', corpusDir(), '--json'])
    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop() as string)
    expect(Array.isArray(parsed.hits)).toBe(true)
    for (const key of ['source', 'file', 'ts', 'fragment']) {
      expect(Object.keys(parsed.hits[0])).toContain(key)
    }
    expect(new Set(parsed.hits.map((h: any) => h.source)).has('transcript')).toBe(true)
    expect(new Set(parsed.hits.map((h: any) => h.source)).has('journal')).toBe(true)
  })

  it('an empty result exits 0 and says so — not finding is not a caller mistake', () => {
    const res = cli(['history', 'search', 'словокотороготочнонет', '--corpus', corpusDir()])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('0')
  })

  it('a bare invocation prints usage and names every book it reads', () => {
    const res = cli(['history', 'search'])
    expect(res.stdout).toContain('usage: sma history search')
    for (const s of HISTORY_SOURCES) expect(res.stdout).toContain(s)
    // and it says what the masking does NOT catch — no promise beyond the truth
    expect(res.stdout).toContain('коротк')
    expect(res.stderr).not.toContain('SMA: сбой команды')
  })

  it('--help exits 0', () => {
    const res = cli(['history', '--help'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('usage: sma history search')
  })
})
