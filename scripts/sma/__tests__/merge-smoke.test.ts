/**
 * Tests for scripts/sma/lib/merge-smoke.mjs — the runner the merge gate is handed.
 *
 * WHAT THIS FILE IS REALLY ABOUT. The runner's job is not «run the tests»; it is to tell the
 * ritual WHICH OF THREE WORLDS it is in — the tests ran and were green, the tests ran and were
 * red, or there was no run at all. The middle and the last used to arrive wearing the same
 * face, and the cost of that confusion is not theoretical: launched by command name and
 * without a shell, the package manager could not be found on this platform at all, the spawn
 * died with a system error, the catch read it as a failing run, and the runner reported RED
 * having executed NOTHING. A gate like that refuses every merge forever and calls it working.
 *
 * So the failure branches here are driven by the SHAPE of a real failure — a spawn that never
 * started carries a system error code and no exit status; a child killed on its deadline
 * carries a signal and no exit status; a child that ran and failed carries a status — and
 * never by a flag that says «pretend this went wrong». A fake that answers from the very
 * distinction under test proves only that the fake works.
 *
 * And because a runner that cannot really launch anything is exactly the defect this module
 * exists to close, two cases here launch REAL child processes over throwaway trees: one where
 * the target passes and one where it fails. Reading the code cannot tell those apart.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import {
  runMergeSmoke,
  resolveSuiteEntry,
  MERGE_SMOKE_TARGET,
  MERGE_SMOKE_TIMEOUT_MS,
  NO_TARGET_NOTE,
  NO_SUITE_RUNNER_NOTE,
  TIMED_OUT_NOTE,
} from '../lib/merge-smoke.mjs'

/** A child process that never started: the shape execFileSync throws on a missing binary. */
function spawnFailure(code: string) {
  const err: any = new Error(`spawnSync ${code}`)
  err.code = code
  err.errno = -4058
  err.status = null
  err.signal = null
  return err
}

/** A child that RAN and left with a non-zero code — the only shape that means «red». */
function exitedWith(status: number) {
  const err: any = new Error(`Command failed with exit code ${status}`)
  err.status = status
  err.signal = null
  return err
}

/** A child killed on its deadline: a signal, no status, and the killed flag execFileSync sets. */
function killedOnDeadline() {
  const err: any = new Error('spawnSync ETIMEDOUT')
  err.killed = true
  err.signal = 'SIGTERM'
  err.status = null
  return err
}

/** A tree where the target exists, so the launch branch is reached. */
const treeWithTarget = { exists: () => true, resolveEntry: () => 'C:/anywhere/suite-runner.mjs' }

describe('the three worlds are told apart — red is never «there was no run»', () => {
  it('a tree without the target gives NO RUN, and nothing is launched at all', () => {
    let launched = 0
    const res: any = runMergeSmoke({
      cwd: '/nowhere',
      exists: () => false,
      resolveEntry: () => 'C:/anywhere/suite-runner.mjs',
      exec: () => {
        launched += 1
      },
    })
    expect(res.passed, 'an empty tree must never read as a red run').toBe(null)
    expect(res.ran).toBe(false)
    expect(res.note).toBe(NO_TARGET_NOTE)
    expect(res.note).toContain(MERGE_SMOKE_TARGET)
    expect(launched, 'the runner launched a suite it already knows is absent').toBe(0)
  })

  it('a suite runner that will not resolve gives NO RUN, not a red verdict', () => {
    let launched = 0
    const res: any = runMergeSmoke({
      cwd: '/repo',
      exists: () => true,
      resolveEntry: () => {
        const err: any = new Error('Cannot find module')
        err.code = 'MODULE_NOT_FOUND'
        throw err
      },
      exec: () => {
        launched += 1
      },
    })
    expect(res.passed).toBe(null)
    expect(res.ran).toBe(false)
    expect(res.note).toBe(NO_SUITE_RUNNER_NOTE)
    expect(launched).toBe(0)
  })

  it('THE MEASURED DEFECT: a spawn that never started is NO RUN, not «tests are red»', () => {
    // This is the exact shape the old body turned into a refusal: on this platform the package
    // manager is a script wrapper, a plain file launch cannot see it, and the error carries a
    // system code with NO exit status. Reading it as red refused every merge on the machine.
    const res: any = runMergeSmoke({
      cwd: '/repo',
      ...treeWithTarget,
      exec: () => {
        throw spawnFailure('ENOENT')
      },
    })
    expect(res.passed, 'a launch that never happened is not a verdict about the tests').toBe(null)
    expect(res.ran).toBe(false)
    expect(res.note).toBe(NO_SUITE_RUNNER_NOTE)
  })

  it('a child killed on its deadline is NO RUN — the machine is not the tests', () => {
    const res: any = runMergeSmoke({
      cwd: '/repo',
      ...treeWithTarget,
      exec: () => {
        throw killedOnDeadline()
      },
    })
    expect(res.passed).toBe(null)
    expect(res.ran).toBe(false)
    expect(res.note).toBe(TIMED_OUT_NOTE)
    expect(res.note).toContain(String(Math.round(MERGE_SMOKE_TIMEOUT_MS / 1000)))
  })

  it('a child that RAN and exited non-zero is red — and carries the code it left with', () => {
    const res: any = runMergeSmoke({
      cwd: '/repo',
      ...treeWithTarget,
      exec: () => {
        throw exitedWith(1)
      },
    })
    expect(res.passed).toBe(false)
    expect(res.ran).toBe(true)
    expect(res.exitCode).toBe(1)
    expect(res.note, 'a verdict has no «why there was no run» to give').toBeUndefined()
  })

  it('a child that RAN and exited zero is green', () => {
    const res: any = runMergeSmoke({ cwd: '/repo', ...treeWithTarget, exec: () => '' })
    expect(res.passed).toBe(true)
    expect(res.ran).toBe(true)
  })
})

describe('the launch itself — the form that was measured to work on this platform', () => {
  it('launches the running interpreter with an ABSOLUTE entry, an args array and no shell', () => {
    const seen: any[] = []
    runMergeSmoke({
      cwd: '/repo',
      exists: () => true,
      resolveEntry: () => 'C:/anywhere/suite-runner.mjs',
      exec: (file: string, args: string[], opts: any) => {
        seen.push({ file, args, opts })
        return ''
      },
    })
    expect(seen.length).toBe(1)
    const [call] = seen
    // the interpreter this process is already running under — never a command name that the
    // platform resolves through a wrapper script.
    expect(call.file).toBe(process.execPath)
    expect(call.file).not.toMatch(/^(npm|pnpm|yarn|npx)(\.|$)/)
    expect(call.args[0]).toBe('C:/anywhere/suite-runner.mjs')
    expect(call.args).toContain(MERGE_SMOKE_TARGET)
    expect(Array.isArray(call.args), 'an args array, never a command string').toBe(true)
    // a shell would make the arguments a sentence the platform re-parses; the cure for the
    // wrapper problem here is the interpreter, not a shell.
    expect(call.opts.shell, 'no shell — the entry is absolute, so none is needed').toBeUndefined()
    expect(call.opts.cwd, 'the run happens in the tree being merged, not in ours').toBe('/repo')
    expect(call.opts.timeout, 'a run without a ceiling can hold the approval door open').toBe(MERGE_SMOKE_TIMEOUT_MS)
  })

  it('the suite runner really resolves from this installation, to a file that exists', () => {
    const entry = resolveSuiteEntry()
    expect(isAbsolute(entry), `the entry must be absolute, got: ${entry}`).toBe(true)
    expect(existsSync(entry), `the resolved suite runner is not on disk: ${entry}`).toBe(true)
  })
})

/**
 * ═══ REAL CHILD PROCESSES ═══════════════════════════════════════════════════════════════
 *
 * Both trees are throwaway and neither is a repository: the runner is handed a directory and
 * a relative target, which is all it ever gets from the ritual. Nothing shared is touched.
 */
describe('the runner actually runs tests — proved by launching them', () => {
  function treeWhoseTargetSays(body: string): string {
    const tree = mkdtempSync(join(tmpdir(), 'sma-smoke-'))
    const target = join(tree, MERGE_SMOKE_TARGET)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `import { describe, it, expect } from 'vitest'\n${body}\n`, 'utf8')
    return tree
  }

  it('a foreign tree whose target PASSES answers green', () => {
    const tree = treeWhoseTargetSays(`describe('smoke', () => { it('passes', () => { expect(1).toBe(1) }) })`)
    try {
      const res: any = runMergeSmoke({ cwd: tree })
      expect(res, `the real runner did not answer green: ${JSON.stringify(res)}`).toMatchObject({
        passed: true,
        ran: true,
      })
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  }, 180000)

  it('a foreign tree whose target FAILS answers red, with the code the child left with', () => {
    const tree = treeWhoseTargetSays(`describe('smoke', () => { it('fails', () => { expect(1).toBe(2) }) })`)
    try {
      const res: any = runMergeSmoke({ cwd: tree })
      expect(res.passed, `the real runner did not answer red: ${JSON.stringify(res)}`).toBe(false)
      expect(res.ran, 'a red verdict must come from a run that HAPPENED').toBe(true)
      expect(typeof res.exitCode, 'a red verdict carries the exit code, not a signal').toBe('number')
      expect(res.exitCode).not.toBe(0)
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  }, 180000)

  it('a foreign tree with NO target answers «there was no run» without launching anything', () => {
    const tree = mkdtempSync(join(tmpdir(), 'sma-smoke-bare-'))
    try {
      const started = Date.now()
      const res: any = runMergeSmoke({ cwd: tree })
      expect(res).toMatchObject({ passed: null, ran: false, note: NO_TARGET_NOTE })
      // no child was started: the answer is immediate, while any real launch on this machine
      // is close to a second even when it finds nothing.
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })
})
