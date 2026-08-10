/**
 * Tests for supervisor/terminal-journal.mjs — the record that decides whether the claim
 * "for a week, the only things left at a terminal were the four agreed ones" is true.
 *
 * Three of these cases are the claim itself: a session start leaves exactly one line, a
 * journal of mixed runs is counted into the four kinds and the rest, and the LAST line the
 * report prints is the number of runs outside the list — because that number is what an
 * acceptance run quotes, and a number a person has to find by reading a table is a number
 * that will eventually be read wrong.
 *
 * The other three are the ways this thing is allowed to fail, and they matter more than the
 * happy path: it may never break a terminal (an unwritable journal exits 0 and says
 * nothing), it may never count the machine's own sessions as terminal work, and it may
 * never print a clean "0" for a journal it could not find.
 *
 * NOT IN SERIAL_SUITES, on purpose. These cases spawn no child process, run no installer
 * and touch no repository: they write a handful of lines into their own `mkdtemp`
 * directory and pass the journal path in explicitly. Nothing here can collide with another
 * worker, so the file keeps the default parallelism (vitest.config.mjs's header explains
 * which files cannot).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JOURNAL_ENV,
  REASON_ENV,
  SAME_TERMINAL_SOURCES,
  WHITELIST,
  OUTSIDE,
  appendEntry,
  buildEntry,
  buildReport,
  classify,
  formatReport,
  journalPath,
  parseReportArgs,
  readLines,
  runLog,
  runReport,
  subjectOf,
} from '../../supervisor/terminal-journal.mjs'

let dir: string
let journal: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-terminal-journal-'))
  journal = join(dir, 'terminal-sessions.ndjson')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const readJournal = (): any[] =>
  readFileSync(journal, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

describe('the journal writes one line per terminal session — and never gets in the way', () => {
  it('two sessions leave two lines, each carrying when, where and what for', () => {
    const env = { [JOURNAL_ENV]: journal } as any
    expect(runLog(['starting the release rebase'], { env, cwd: 'C:/work/sma', event: null })).toBe(0)
    expect(runLog([], { env, cwd: 'C:/work/other', event: null })).toBe(0)

    const lines = readJournal()
    expect(lines).toHaveLength(2)
    expect(lines[0].cmd).toBe('starting the release rebase')
    expect(lines[0].cwd).toBe('C:/work/sma')
    expect(typeof lines[0].ts).toBe('string')
    expect(new Date(lines[0].ts).toISOString()).toBe(lines[0].ts)
    expect(lines[1].cmd).toBe('')
  })

  it('an unwritable journal is silent and still exits 0 — a terminal is never blocked', () => {
    // A file where a directory would have to be: mkdir cannot make it, append cannot open it.
    const blocked = join(dir, 'not-a-directory')
    writeFileSync(blocked, 'this is a file', 'utf8')
    const doomed = join(blocked, 'nested', 'terminal-sessions.ndjson')

    expect(appendEntry(doomed, { ts: 'x', cwd: 'y', cmd: 'z' })).toBe(false)
    expect(runLog(['anything'], { env: { [JOURNAL_ENV]: doomed } as any, event: null })).toBe(0)
  })

  it('a session the daemon spawned is NOT a terminal run — the env it stamps keeps it out', () => {
    const env = { [JOURNAL_ENV]: journal, SMA_HEADLESS: '1' } as any
    expect(runLog(['a stage the daemon started'], { env, event: null })).toBe(0)
    expect(() => readFileSync(journal, 'utf8')).toThrow()
  })

  it('clearing or compacting a window already in the journal adds NOTHING — one terminal, one line', () => {
    const env = { [JOURNAL_ENV]: journal } as any
    expect(runLog([], { env, event: { cwd: 'C:/work/sma', source: 'startup' } })).toBe(0)
    for (const source of SAME_TERMINAL_SOURCES) {
      expect(runLog([], { env, event: { cwd: 'C:/work/sma', source } })).toBe(0)
      expect(runLog([], { env, event: { cwd: 'C:/work/sma', source: ` ${source} ` } })).toBe(0)
    }
    // The afternoon above is ONE terminal that cleared its context four times. Before this
    // lock the report read it as five runs outside the list and failed a clean day.
    expect(readJournal()).toHaveLength(1)
    expect(readJournal()[0].source).toBe('startup')
  })

  it('a resumed session IS a terminal run — only the two same-window restarts are dropped', () => {
    const env = { [JOURNAL_ENV]: journal } as any
    expect(runLog([], { env, event: { cwd: 'C:/work/sma', source: 'resume' } })).toBe(0)
    // An unknown event name is written, not guessed at: the list of what to drop is closed,
    // and a run that wants to be excused has to say so.
    expect(runLog([], { env, event: { cwd: 'C:/work/sma', source: 'something-new' } })).toBe(0)
    expect(readJournal().map((l) => l.source)).toEqual(['resume', 'something-new'])
  })

  it('the hook’s own event supplies the directory and the kind of start, when there is one', () => {
    const entry = buildEntry({
      argv: ['claude'],
      env: { [REASON_ENV]: 'baseline measurement' } as any,
      cwd: 'C:/wrong',
      now: new Date('2026-08-07T04:05:06Z'),
      event: { cwd: 'C:/work/sma', source: 'startup', session_id: 'abc' },
    })
    expect(entry).toEqual({
      ts: '2026-08-07T04:05:06.000Z',
      cwd: 'C:/work/sma',
      cmd: 'claude',
      why: 'baseline measurement',
      source: 'startup',
    })
    // The session id is deliberately NOT carried: the journal answers "how many runs and of
    // what kind", and an identifier of a session is not part of that answer.
    expect(Object.keys(entry)).not.toContain('session_id')
  })

  it('the journal lives beside the daemon’s own state, and the override is what moves it', () => {
    expect(journalPath({ [JOURNAL_ENV]: 'D:/elsewhere/j.ndjson' } as any)).toBe('D:/elsewhere/j.ndjson')
    expect(journalPath({} as any).replace(/\\/g, '/')).toMatch(/\.sma-daemon\/terminal-sessions\.ndjson$/)
  })
})

describe('the four kinds of work that may stay at a terminal — and everything else', () => {
  it('is a CLOSED list of four, described by what a person is doing', () => {
    expect(WHITELIST).toHaveLength(4)
    expect(WHITELIST.map((k: any) => k.id)).toEqual([
      'measurement',
      'history-surgery',
      'framework-removal',
      'daemon-repair',
    ])
  })

  it('puts each of the four where it belongs, in either language', () => {
    expect(classify('baseline run before the release')).toBe('measurement')
    expect(classify('замер на чистом корпусе')).toBe('measurement')
    expect(classify('git rebase -i origin/main')).toBe('history-surgery')
    expect(classify('git push --force after the squash')).toBe('history-surgery')
    expect(classify('/sma-deleteme in the old project')).toBe('framework-removal')
    expect(classify('the daemon is dead again, reading its log')).toBe('daemon-repair')
    expect(classify('node supervisor/live-smoke-windows.mjs')).toBe('daemon-repair')
  })

  it('excuses NOTHING by default: ordinary work, and an unlabelled session, are outside', () => {
    expect(classify('write the new screen')).toBe(OUTSIDE)
    expect(classify('')).toBe(OUTSIDE)
    expect(classify(undefined as any)).toBe(OUTSIDE)
    expect(subjectOf({ why: 'git rebase', cmd: 'claude' })).toBe('git rebase claude')
  })
})

describe('the report answers with a number, and earns it', () => {
  const fixture = [
    { ts: '2026-08-03T09:00:00.000Z', cwd: 'C:/work/sma', cmd: 'claude', why: 'baseline measurement' },
    { ts: '2026-08-03T11:00:00.000Z', cwd: 'C:/work/sma', cmd: 'git rebase -i origin/main' },
    { ts: '2026-08-04T08:00:00.000Z', cwd: 'C:/work/app', cmd: 'fixing the login form' },
    { ts: '2026-08-04T20:00:00.000Z', cwd: 'C:/work/sma', cmd: 'the daemon is dead, restarting it by hand' },
    { ts: '2026-08-05T10:00:00.000Z', cwd: 'C:/work/app', cmd: 'writing the release notes' },
  ]

  const write = (lines: string[]) => writeFileSync(journal, lines.join('\n') + '\n', 'utf8')

  it('five runs, three of them agreed — the LAST line printed is “2”', () => {
    write(fixture.map((f) => JSON.stringify(f)))
    const out: string[] = []
    const code = runReport({ file: journal }, (s: string) => out.push(s))

    expect(code).toBe(0)
    const printed = out.join('\n').trimEnd().split('\n')
    expect(printed[printed.length - 1]).toBe('2')
    expect(printed.join('\n')).toContain('total 5    within the list 3    outside 2')
  })

  it('a line nobody can parse does not crash the report — it is counted outside, honestly', () => {
    write([...fixture.map((f) => JSON.stringify(f)), '{ this line was truncated by a crash'])
    const report = buildReport(readLines(readFileSync(journal, 'utf8')))

    expect(report.total).toBe(6)
    expect(report.outside).toBe(3)
    expect(report.rows.filter((r: any) => r.malformed)).toHaveLength(1)
    const printed = formatReport(report).trimEnd().split('\n')
    expect(printed[printed.length - 1]).toBe('3')
    expect(printed.join('\n')).toContain('unreadable line:')
  })

  it('--since narrows the window, and keeps the lines that cannot say when they happened', () => {
    write([...fixture.map((f) => JSON.stringify(f)), 'not json at all'])
    const report = buildReport(readLines(readFileSync(journal, 'utf8')), { since: '2026-08-04' })

    expect(report.total).toBe(4) // two runs on the 4th, one on the 5th, plus the unreadable one
    expect(report.outside).toBe(3)
    expect(parseReportArgs(['--since', '2026-08-04']).since).toBe('2026-08-04')
    expect(() => parseReportArgs(['--since', 'yesterday'])).toThrow(/YYYY-MM-DD/)
    expect(() => parseReportArgs(['--all'])).toThrow(/unknown option/)
  })

  it('a journal that does not exist prints NO number and exits 3 — absence proves nothing', () => {
    const out: string[] = []
    const errs: string[] = []
    const code = runReport({ file: join(dir, 'never-written.ndjson') }, (s: string) => out.push(s), (s: string) => errs.push(s))

    expect(code).toBe(3)
    expect(out).toEqual([])
    expect(errs.join('\n')).toMatch(/no journal at/)
  })

  it('an empty window says so instead of pretending the table was full', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(journal, '', 'utf8')
    const out: string[] = []
    expect(runReport({ file: journal }, (s: string) => out.push(s))).toBe(0)
    const printed = out.join('\n').trimEnd().split('\n')
    expect(printed[printed.length - 1]).toBe('0')
    expect(out.join('\n')).toContain('(no runs in this window)')
  })
})
