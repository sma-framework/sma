/**
 * `memory write` — WHOSE corpus a lesson lands in when nobody says which.
 *
 * WHY THIS FILE EXISTS. A worker runs in a linked working copy of the project:
 * its own directory, its own branch, its own review. It finishes a task, writes
 * down what it learned, and the note has to travel WITH the branch — that is the
 * whole point of writing it there rather than anywhere else.
 *
 * The coordination directory (`.sma/`) is deliberately shared by every working
 * copy of a project: claims, sessions and the journal have to be one list, or
 * two terminals cannot see each other. Resolving it walks git's COMMON directory,
 * which always answers with the main checkout. That is right for coordination and
 * a trap for the corpus: taking the memory directory from the same answer sends a
 * lesson written in a copy into the MAIN tree's drafts — off the branch, past the
 * acceptance step, invisible to the person reviewing that branch. The note is not
 * lost; it is filed under someone else's name.
 *
 * So the default corpus is the CURRENT tree's own `.claude/memory`, resolved from
 * the top level of the directory the verb was called in. `--corpus` still wins
 * over it, a call from the main tree is unchanged, and outside a repository the
 * old fallback stands.
 *
 * NO FAKE GIT HERE. Whether a linked copy and the main tree disagree about "the
 * repository root" is a question only a real repository can answer, and a double
 * that answers it would be answering from the same assumption under test. Every
 * case below runs `git init`, a real `git worktree add`, and spawns the real CLI
 * in a throwaway directory. Nothing outside `mkdtemp` is touched, and the copy is
 * removed before git is asked to forget it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'cli.mjs')

let sandbox: string
let mainTree: string
let copyTree: string
let plainDir: string
let foreignTree: string

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** The top level git reports for a directory, or null when it is not in a repository. */
function topLevelOf(cwd: string): string | null {
  try {
    // stderr is dropped, not piped: "not a git repository" is the ANSWER here,
    // and printing it beside the report reads like a failure.
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * Run the real CLI. The root override is REMOVED from the environment on purpose:
 * the resolver under test is the real one, and pinning it would delete the subject.
 */
function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.SMA_ROOT_OVERRIDE
  env.SMA_DISABLE_SNAPSHOT_SPAWN = '1' // no detached reporter child out of a throwaway directory
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: env as NodeJS.ProcessEnv,
    })
    return { stdout, stderr: '', status: 0 }
  } catch (err: any) {
    return {
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? ''),
      status: typeof err?.status === 'number' ? err.status : 1,
    }
  }
}

/** The verb's answer: the LAST line of stdout that is a JSON object. */
function lastJson(stdout: string): any {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('{'))
  return line ? JSON.parse(line) : null
}

/** One lesson-shaped note: a procedural observation, which the pipeline always stages. */
function writeLesson(cwd: string, id: string, extra: string[] = []) {
  const res = runCli(
    [
      'memory', 'write',
      '--type', 'procedural',
      '--truth', 'observed',
      '--authority', 'self-observed',
      '--evidence', 't:test',
      '--id', id,
      '--claim', 'alpha',
      '--body', 'beta',
      '--areas', 'workflow',
      '--language', 'ru',
      '--json',
      ...extra,
    ],
    cwd,
  )
  return { ...res, json: lastJson(res.stdout) }
}

const draftPath = (root: string, id: string) => join(root, '.claude', 'memory', 'drafts', `${id}.md`)

/** A corpus is a directory with a drafts/ door — nothing else is needed to stage a note. */
function seedCorpus(root: string) {
  mkdirSync(join(root, '.claude', 'memory', 'drafts'), { recursive: true })
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'sma-memory-corpus-'))
  mainTree = join(sandbox, 'main')
  copyTree = join(sandbox, 'copy')
  plainDir = join(sandbox, 'plain')

  mkdirSync(mainTree, { recursive: true })
  git(['init', '-b', 'main'], mainTree)
  git(['config', 'user.email', 'suite@example.invalid'], mainTree)
  git(['config', 'user.name', 'Suite'], mainTree)
  writeFileSync(join(mainTree, 'README.md'), '# sandbox\n')
  git(['add', 'README.md'], mainTree)
  git(['commit', '-m', 'the one commit a worktree can branch from'], mainTree)
  seedCorpus(mainTree)

  // The worker's working copy: its own directory, its own branch, its own corpus.
  git(['worktree', 'add', '-b', 'wt/copy-under-test', copyTree], mainTree)
  seedCorpus(copyTree)

  mkdirSync(plainDir, { recursive: true })

  // Somebody ELSE's project: a second corpus that is not the corpus of any tree
  // the verb below is called from. Nothing about the RECORD differs — only the
  // destination — which is the whole point of the cases at the end of this file.
  foreignTree = join(sandbox, 'foreign')
  mkdirSync(foreignTree, { recursive: true })
  seedCorpus(foreignTree)
})

afterAll(() => {
  // Remove the copy OURSELVES and only then let git forget it: `worktree remove`
  // follows what it finds inside a copy, and the sandbox is the only thing here
  // that may be deleted. Nothing outside mkdtemp is ever named.
  try {
    rmSync(copyTree, { recursive: true, force: true })
    git(['worktree', 'prune'], mainTree)
  } catch {
    /* the sandbox goes either way */
  }
  rmSync(sandbox, { recursive: true, force: true })
})

describe('memory write — the default corpus belongs to the tree the verb was called in', () => {
  it('Case A: a lesson written from a linked copy, with no --corpus, drafts into the COPY', () => {
    const id = 'lesson-copy-default-alpha'
    const { status, stdout, stderr, json } = writeLesson(copyTree, id)

    expect({ status, stderr }).toEqual({ status: 0, stderr: '' })
    expect(json?.outcome).toBe('staged-draft')
    expect(stdout).toContain('staged-draft')

    // The branch keeps its own lesson …
    expect(existsSync(draftPath(copyTree, id))).toBe(true)
    // … and the main tree never hears about it. This is the whole defect: a note
    // filed in the main tree is off the branch and past the acceptance step.
    expect(existsSync(draftPath(mainTree, id))).toBe(false)
  })

  it('Case B: an explicit --corpus still wins over the default', () => {
    const id = 'lesson-copy-explicit-beta'
    const { status, json } = writeLesson(copyTree, id, ['--corpus', join(copyTree, '.claude', 'memory')])

    expect(status).toBe(0)
    expect(json?.outcome).toBe('staged-draft')
    expect(existsSync(draftPath(copyTree, id))).toBe(true)
    expect(existsSync(draftPath(mainTree, id))).toBe(false)
  })

  it('Case C: called from the main tree, nothing changes — the note lands there', () => {
    const id = 'lesson-main-default-gamma'
    const { status, json } = writeLesson(mainTree, id)

    expect(status).toBe(0)
    expect(json?.outcome).toBe('staged-draft')
    expect(existsSync(draftPath(mainTree, id))).toBe(true)
    expect(existsSync(draftPath(copyTree, id))).toBe(false)
  })

  it('Case D: outside a repository the old fallback stands — the note lands in the caller', () => {
    // Stated rather than assumed: if the throwaway directory were itself inside a
    // repository this case would be measuring something else, and should say so
    // out loud instead of passing quietly.
    expect(topLevelOf(plainDir)).toBeNull()

    const id = 'lesson-plain-default-delta'
    const { status, json } = writeLesson(plainDir, id)

    expect(status).toBe(0)
    expect(json?.outcome).toBe('staged-draft')
    expect(existsSync(draftPath(plainDir, id))).toBe(true)
  })
})

/**
 * A record of the ONE class this pipeline may write with no human in the loop:
 * a low-risk working observation with an expiry and a fingerprint. Written on
 * purpose — a lesson-shaped note stages anyway, so it could not tell a forced
 * stage apart from the ordinary one.
 *
 * No `--json`: the case below is about what a PERSON is told, and in machine
 * mode the verb prints machine output only.
 */
function writeAutomatic(cwd: string, id: string, extra: string[] = []) {
  return runCli(
    [
      'memory', 'write',
      '--type', 'working',
      '--truth', 'observed',
      '--risk', 'low',
      '--retention', 'P30D',
      '--product-version', 'v5.0.4',
      '--id', id,
      '--claim', `the drain window measured for ${id}`,
      '--body', 'measured during the drill',
      '--areas', 'queue',
      ...extra,
    ],
    cwd,
  )
}

const corpusOf = (root: string) => join(root, '.claude', 'memory')
const notePath = (root: string, id: string) => join(corpusOf(root), `${id}.md`)

/** Every regular file directly inside a corpus (drafts/ is a directory and never appears). */
function corpusFiles(root: string): string[] {
  const dir = corpusOf(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort()
}

describe('memory write — a corpus that belongs to another project is never written to directly', () => {
  it('Case E: an explicit --corpus of ANOTHER tree forces the record into that tree\'s drafts, with the reason in words', () => {
    const id = 'working-foreign-corpus-epsilon'
    const before = corpusFiles(foreignTree)

    const { status, stdout, stderr } = writeAutomatic(copyTree, id, ['--corpus', corpusOf(foreignTree)])

    expect({ status, stderr }).toEqual({ status: 0, stderr: '' })

    // 1. The outcome: this record was entitled to the automatic door and did not get it.
    expect(stdout).toContain('staged-draft')

    // 2. The proof is the FILE, in the FOREIGN corpus' drafts/ — not a verdict string.
    expect(existsSync(draftPath(foreignTree, id))).toBe(true)

    // 3. Nothing became active memory over there: the foreign corpus outside drafts/
    //    is byte-for-byte the same list it was before the call.
    expect(corpusFiles(foreignTree)).toEqual(before)
    expect(existsSync(notePath(foreignTree, id))).toBe(false)

    // 4. The caller's own tree is untouched — the record went where it was addressed.
    expect(existsSync(notePath(copyTree, id))).toBe(false)
    expect(existsSync(draftPath(copyTree, id))).toBe(false)

    // 5. The person is told WHY, and what to type if they meant it: the reason names
    //    the foreign corpus and the hand-applied door out of drafts/.
    expect(stdout).toContain('чужой проект')
    expect(stdout).toContain('--apply')
    expect(stdout).toContain('--confirm')
    expect(stdout).toContain('--yes')
  })

  it('Case F: the control — the same record with NO --corpus behaves exactly as before', () => {
    const id = 'working-own-corpus-zeta'
    const { status, stdout } = writeAutomatic(copyTree, id)

    expect(status).toBe(0)
    expect(stdout).toContain('persisted-active')
    expect(stdout).not.toContain('чужой проект')
    expect(existsSync(notePath(copyTree, id))).toBe(true)
    expect(existsSync(draftPath(copyTree, id))).toBe(false)
  })

  it('Case G: a --corpus that NAMES the current tree\'s own corpus is not foreign — a copy is its own project', () => {
    // This is the law resolveCorpusDefault is written to protect: a worker's linked
    // copy answers with ITS OWN corpus, so a lesson written there is a legitimate
    // local case. Saying the same directory out loud must not change the answer.
    const id = 'working-own-corpus-named-eta'
    const { status, stdout } = writeAutomatic(copyTree, id, ['--corpus', corpusOf(copyTree)])

    expect(status).toBe(0)
    expect(stdout).toContain('persisted-active')
    expect(stdout).not.toContain('чужой проект')
    expect(existsSync(notePath(copyTree, id))).toBe(true)
  })
})
