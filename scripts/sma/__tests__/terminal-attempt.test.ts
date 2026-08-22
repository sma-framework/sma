/**
 * The attempt trail of a TERMINAL window — the same row a worker leaves, written by the
 * same writer, into a directory of its own.
 *
 * WHY THIS FILE EXISTS. A worker's try leaves a durable row: the commit its copy was cut
 * from, the files it changed against that commit, and a verdict. A person's window left
 * neither — the coordination journal knows that a scope was claimed and released, and
 * nothing about the point of return or what actually moved between the two moments. So
 * «откатить можно» was true for a worker and merely hoped for a window.
 *
 * WHAT IS LOCKED HERE IS THE WIRE, NOT THE COMPUTATION. Every case below asserts that a
 * value REACHED somewhere — a file on disk, a second line in that file, a printed verdict
 * from a real child process — because the failure this trail was built against is the one
 * where each piece is written, tested and green, and no piece is joined to the next. A
 * function that computes a base commit and hands it to nobody exits zero and looks right.
 *
 * THE GIT HERE IS REAL. Every case runs against a throwaway repository in the operating
 * system's temp directory with one real commit in it, and the base commit is compared with
 * what `git rev-parse` answers in that repository — not with a string a fixture remembered.
 * A parser measured against a fake is green against the fake and wrong against git.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  startTerminalAttempt,
  readAttemptBase,
  turnDiffVerdict,
  completeTerminalAttempt,
  terminalAttemptsDir,
} from '../lib/terminal-attempt.mjs'
// The REAL list, imported — not a second copy of it. A copied list agrees with the original
// on the day it is typed and stops agreeing the first time one of the two is extended.
import { ALLOWED_ATTEMPT_KEYS } from '../../../daemon/src/queue/attempt-ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'cli.mjs')

const MADE: string[] = []
afterAll(() => {
  for (const d of MADE) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* a temp dir that refuses to go is not a test failure */
    }
  }
})

/** A throwaway repository with exactly one commit — the world every case starts in. */
function scratchRepo(): { repo: string; git: (args: string[]) => string; ledgerDir: string } {
  const repo = mkdtempSync(join(tmpdir(), 'sma-attempt-trail-'))
  MADE.push(repo)
  const git = (args: string[]) => String(execFileSync('git', args, { cwd: repo, encoding: 'utf8' }))
  git(['init', '-q'])
  git(['config', 'user.email', 'suite@example.invalid'])
  git(['config', 'user.name', 'suite'])
  git(['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'a.txt'), 'a\n')
  git(['add', '--', 'src/a.txt'])
  git(['commit', '-q', '--no-verify', '-m', 'init'])
  return { repo, git, ledgerDir: join(repo, '.sma', 'attempts') }
}

/** Every JSON row of one slug's ledger file, in the order it was appended. */
function rowsOf(ledgerDir: string, slug: string): any[] {
  return readFileSync(join(ledgerDir, `${slug}.jsonl`), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const IDENTITY = { holderIdentity: 'okno-a', terminalId: 'okno-a' }

describe('a claimed scope leaves a point of return on disk', () => {
  it('writes the base commit the repository actually reports, into the terminal ledger', () => {
    const { repo, git, ledgerDir } = scratchRepo()
    const slug = 'reestr-terminala'

    startTerminalAttempt({ slug, description: 'реестр терминала', identity: IDENTITY, ledgerDir, cwd: repo })

    const file = join(ledgerDir, `${slug}.jsonl`)
    expect(existsSync(file), 'the ledger file the claim was supposed to create').toBe(true)
    const rows = rowsOf(ledgerDir, slug)
    expect(rows).toHaveLength(1)
    // The live repository is the reference, never a remembered string.
    expect(rows[0].base).toBe(git(['rev-parse', 'HEAD']).trim())
    expect(rows[0].branch).toBe(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim())
    expect(typeof rows[0].startedAt).toBe('string')
    expect(rows[0].taskId).toBe(slug)
  })

  it("the terminal attempt row carries the worker's keys", () => {
    const { repo, ledgerDir } = scratchRepo()
    const slug = 'kluchi-stroki'
    startTerminalAttempt({ slug, description: 'ключи строки', identity: IDENTITY, ledgerDir, cwd: repo })
    const [row] = rowsOf(ledgerDir, slug)
    // `recordedAt` is stamped by the writer itself and is not a caller-supplied name.
    const allowed = new Set([...ALLOWED_ATTEMPT_KEYS, 'recordedAt'])
    const strangers = Object.keys(row).filter((k) => !allowed.has(k))
    expect(strangers, 'a terminal row may not invent a name the worker\'s row does not have').toEqual([])
  })

  it('reads its own base back, and answers nothing when there is no ledger at all', () => {
    const { repo, git, ledgerDir } = scratchRepo()
    expect(readAttemptBase({ slug: 'nikogda-ne-bylo', ledgerDir })).toBe(null)
    startTerminalAttempt({ slug: 'chitaem-bazu', description: 'читаем базу', identity: IDENTITY, ledgerDir, cwd: repo })
    const back = readAttemptBase({ slug: 'chitaem-bazu', ledgerDir })
    expect(back?.base).toBe(git(['rev-parse', 'HEAD']).trim())
  })
})

describe('the turn gate names the file that actually moved', () => {
  it('a change inside the claimed area reads as inside; one outside is named out loud', async () => {
    const { repo, git, ledgerDir } = scratchRepo()
    const slug = 'oblast-pretenzii'
    startTerminalAttempt({ slug, description: 'область претензии', identity: IDENTITY, ledgerDir, cwd: repo })

    writeFileSync(join(repo, 'src', 'a.txt'), 'a changed\n')
    git(['add', '--', 'src/a.txt'])
    git(['commit', '-q', '--no-verify', '-m', 'inside'])

    const inside = await turnDiffVerdict({ slug, globs: ['src/**'], ledgerDir, cwd: repo })
    expect(inside.files.map((f: any) => f.path)).toContain('src/a.txt')
    expect(inside.outside).toEqual([])
    expect(inside.verdict).toBe('в области')

    writeFileSync(join(repo, 'docs.md'), 'docs\n')
    git(['add', '--', 'docs.md'])
    git(['commit', '-q', '--no-verify', '-m', 'outside'])

    const out = await turnDiffVerdict({ slug, globs: ['src/**'], ledgerDir, cwd: repo })
    expect(out.outside, 'the path that fell out of the claimed area').toEqual(['docs.md'])
    expect(out.verdict).toBe('вне области')
  })

  it('answers «not measured» rather than a verdict when there is no base to measure against', async () => {
    const { repo, ledgerDir } = scratchRepo()
    const v = await turnDiffVerdict({ slug: 'bazy-net', globs: ['src/**'], ledgerDir, cwd: repo })
    expect(v.verdict).toBe(null)
    expect(v.base).toBe(null)
  })

  it('asks git for nothing but a read: a runner that knows only rev-parse and diff is enough', async () => {
    const { repo, git, ledgerDir } = scratchRepo()
    const slug = 'appetit-glagola'
    // A fake richer than the live object hides a defect twice over: it answers calls the real
    // thing would refuse. This one refuses everything but the two read verbs, so the day the
    // gate grows an appetite for a third, this case is the one that says so.
    const seen: string[] = []
    const execGit = (args: string[], opts: any) => {
      const verb = args.find((a) => !String(a).startsWith('-') && a !== 'core.quotepath=false')
      seen.push(String(verb))
      if (verb !== 'rev-parse' && verb !== 'diff') throw new Error(`the turn gate may not run git ${verb}`)
      return String(execFileSync('git', args, { cwd: (opts && opts.cwd) || repo, encoding: 'utf8' }))
    }

    startTerminalAttempt({ slug, description: 'аппетит глагола', identity: IDENTITY, ledgerDir, cwd: repo, execGit })
    writeFileSync(join(repo, 'src', 'a.txt'), 'moved\n')
    git(['add', '--', 'src/a.txt'])
    git(['commit', '-q', '--no-verify', '-m', 'move'])

    const v = await turnDiffVerdict({ slug, globs: ['src/**'], ledgerDir, cwd: repo, execGit })
    expect(v.verdict).toBe('в области')
    expect(new Set(seen)).toEqual(new Set(['rev-parse', 'diff']))
  })
})

describe('releasing a claim closes the row without rewriting the one before it', () => {
  it('appends a second line carrying the files and the verdict; the first line is untouched', async () => {
    const { repo, git, ledgerDir } = scratchRepo()
    const slug = 'zavershenie'
    startTerminalAttempt({ slug, description: 'завершение', identity: IDENTITY, ledgerDir, cwd: repo })
    const first = rowsOf(ledgerDir, slug)[0]

    writeFileSync(join(repo, 'src', 'a.txt'), 'done\n')
    git(['add', '--', 'src/a.txt'])
    git(['commit', '-q', '--no-verify', '-m', 'work'])

    const verdict = await turnDiffVerdict({ slug, globs: ['src/**'], ledgerDir, cwd: repo })
    completeTerminalAttempt({ slug, verdict, identity: IDENTITY, ledgerDir, cwd: repo })

    const rows = rowsOf(ledgerDir, slug)
    expect(rows, 'append-only: two lines, not one rewritten one').toHaveLength(2)
    expect(rows[0]).toEqual(first)
    expect(rows[1].files.map((f: any) => f.path)).toContain('src/a.txt')
    expect(rows[1].outcome).toBe('completed')
    expect(typeof rows[1].endedAt).toBe('string')
    const allowed = new Set([...ALLOWED_ATTEMPT_KEYS, 'recordedAt'])
    expect(Object.keys(rows[1]).filter((k) => !allowed.has(k))).toEqual([])
  })

  it('a change outside the claimed area is recorded as a refused verdict, with the names in it', async () => {
    const { repo, git, ledgerDir } = scratchRepo()
    const slug = 'vne-oblasti'
    startTerminalAttempt({ slug, description: 'вне области', identity: IDENTITY, ledgerDir, cwd: repo })
    writeFileSync(join(repo, 'docs.md'), 'x\n')
    git(['add', '--', 'docs.md'])
    git(['commit', '-q', '--no-verify', '-m', 'stray'])

    const verdict = await turnDiffVerdict({ slug, globs: ['src/**'], ledgerDir, cwd: repo })
    completeTerminalAttempt({ slug, verdict, identity: IDENTITY, ledgerDir, cwd: repo })

    const last = rowsOf(ledgerDir, slug).at(-1)
    expect(last.outcome).toBe('failed')
    expect(last.failureReason).toContain('docs.md')
  })

  it('never throws when the world is missing: no slug, no ledger, no git', async () => {
    expect(() => startTerminalAttempt({})).not.toThrow()
    expect(() => completeTerminalAttempt({})).not.toThrow()
    await expect(turnDiffVerdict({})).resolves.toBeTruthy()
    expect(readAttemptBase({})).toBe(null)
    expect(typeof terminalAttemptsDir({ env: {} })).toBe('string')
  })
})

describe('the verbs a person actually types leave the trail — end to end, in a real process', () => {
  it('claim writes the base, the turn gate prints a verdict, release closes the row', () => {
    const { repo, git, ledgerDir } = scratchRepo()
    const smaRoot = join(repo, '.sma')
    const env = {
      ...process.env,
      SMA_ROOT_OVERRIDE: smaRoot,
      CLAUDE_PROJECT_DIR: repo,
      SMA_TERMINAL_NAME: 'Окно-проба',
      SMA_DISABLE_SNAPSHOT_SPAWN: '1',
    }
    const run = (args: string[], input = '') =>
      spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env, input })

    const claimed = run(['claim', 'proba', '--globs', 'src/**', '--desc', 'проба следа попытки'])
    expect(claimed.status, `${claimed.stdout}${claimed.stderr}`).toBe(0)

    // the slug the claim filed under — the ledger file is named by it
    const slugLine = /force-clear ([^\s]+)/.exec(claimed.stdout)
    expect(slugLine, `no slug printed: ${claimed.stdout}`).toBeTruthy()
    const slug = String(slugLine![1])

    const started = rowsOf(ledgerDir, slug)
    expect(started, 'the claim left exactly one opening row').toHaveLength(1)
    expect(started[0].base).toBe(git(['rev-parse', 'HEAD']).trim())

    writeFileSync(join(repo, 'src', 'a.txt'), 'through the verbs\n')
    git(['add', '--', 'src/a.txt'])
    git(['commit', '-q', '--no-verify', '-m', 'work'])

    const turn = run(['turn-diff'], '{}')
    expect(turn.status, `${turn.stdout}${turn.stderr}`).toBe(0)
    // the line names the base the claim recorded and the verdict about the claimed area —
    // the measurement reached the window, not just the disk
    expect(turn.stdout, 'the turn gate said nothing at all').toContain(started[0].base.slice(0, 7))
    expect(turn.stdout).toContain('в области')

    const released = run(['release', 'proba'])
    expect(released.status, `${released.stdout}${released.stderr}`).toBe(0)
    expect(released.stdout).toContain(started[0].base.slice(0, 7))

    const rows = rowsOf(ledgerDir, slug)
    expect(rows, 'claim and release each left one line').toHaveLength(2)
    expect(rows[1].files.map((f: any) => f.path)).toContain('src/a.txt')
    expect(rows[1].outcome).toBe('completed')
  })

  it('the turn gate is silent and exits zero when this window holds no claim', () => {
    const { repo } = scratchRepo()
    const env = {
      ...process.env,
      SMA_ROOT_OVERRIDE: join(repo, '.sma'),
      CLAUDE_PROJECT_DIR: repo,
      SMA_TERMINAL_NAME: 'Окно-молчит',
      SMA_DISABLE_SNAPSHOT_SPAWN: '1',
    }
    const r = spawnSync(process.execPath, [CLI, 'turn-diff'], { cwd: repo, encoding: 'utf8', env, input: '{}' })
    expect(r.status).toBe(0)
    expect(r.stdout.trim(), 'a window with nothing claimed must not speak on every turn').toBe('')
  })
})
