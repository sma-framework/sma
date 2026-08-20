/**
 * Tests for daemon/src/main.mjs — IS THE MERGE GATE'S TEST RUNNER ACTUALLY CONNECTED?
 *
 * WHY THIS FILE EXISTS. The approval door builds its merge as a closure over whatever runner
 * the composition root hands it, and the root used to hand over an injection slot: production
 * calls the factory with NO overrides, so the slot was empty, so the gate that decides whether
 * accepted work enters the trunk ran no tests at all. Everything around it was green — the
 * ritual had its suite, the runner had its own, the door had its handler tests — because every
 * one of those built its OWN daemon and passed in its OWN runner. A test that assembles the
 * thing it is testing can only ever prove that assembly.
 *
 * So this file builds THE REAL ONE: `createDaemon()` with no collaborator overrides, exactly
 * as the production entry point calls it, and then asks the assembled object questions it
 * cannot answer by accident. The strongest of them is not about a field at all — it CALLS the
 * door's own merge closure over a throwaway repository and reads the receipt. If the wire is
 * cut, the receipt says «no runner was wired»; with the wire in place it says what the RUNNER
 * says. Two sentences, one of them impossible unless the argument travelled all the way from
 * the root into the ritual's call.
 *
 * NOTHING SHARED IS TOUCHED. The config pin points at a temp file with temp directories and a
 * queue address on a closed port; the daemon is only WIRED, never started. The merge is driven
 * over a throwaway repository with ITS OWN reservation and journal directories — the shared
 * merge slot of this checkout is never taken, because other windows work in this tree and a
 * test that grabs their slot leaves a holder behind when it falls.
 *
 * GIT HERE IS REAL, AND ITS ABSENCE IS RED. A run that did not happen is never a pass: if git
 * is not on this machine the setup throws and this file goes red with a sentence saying so,
 * rather than quietly skipping and reporting a green suite that measured nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDaemon } from '../src/main.mjs'
import { NO_RUNNER_NOTE } from '../../scripts/sma/lib/merge-gate.mjs'
import { MERGE_SMOKE_TARGET, NO_TARGET_NOTE } from '../../scripts/sma/lib/merge-smoke.mjs'

const TOKEN = 'd'.repeat(64)

let tmpRoot: string
let park: any
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(
      `git недоступен на этой машине, поэтому провод НЕ ПРОВЕРЕН: ${String(err)}. ` +
        'Прогон, которого не было, никогда не считается проходом — это красное, а не пропуск.',
    )
  }

  tmpRoot = mkdtempSync(join(tmpdir(), 'sma-merge-wire-'))
  const repoDir = join(tmpRoot, 'repo')
  mkdirSync(repoDir, { recursive: true })
  const configPath = join(tmpRoot, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      // a CLOSED port: the daemon is wired and never started, so nothing dials it.
      queueUrl: 'postgres://127.0.0.1:1/sma_none',
      bind: '127.0.0.1',
      port: 7801,
      token: TOKEN,
      repoDir,
      dataDir: join(tmpRoot, 'data'),
      ledgerDir: join(tmpRoot, 'ledger'),
      projects: [{ id: 'p1', name: 'p1' }],
      activeProject: 'p1',
    }),
    'utf8',
  )
  for (const key of ['SMA_DAEMON_CONFIG', 'SMA_DAEMON_MCP']) savedEnv[key] = process.env[key]
  process.env.SMA_DAEMON_CONFIG = configPath
  process.env.SMA_DAEMON_MCP = join(tmpRoot, 'absent-mcp.json')

  // THE PRODUCTION FACTORY, no overrides — the same call the production entry point makes.
  park = createDaemon()
})

afterAll(() => {
  try {
    if (park && park.hub && typeof park.hub.close === 'function') park.hub.close()
    if (park && park.daemon && typeof park.daemon.stop === 'function') park.daemon.stop()
  } catch {
    /* best-effort */
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('the merge gate of a PRODUCTION daemon has tests to run', () => {
  /** The weakest claim, and the only one a stub could satisfy — kept as the first step. */
  it('the assembled door names a merge-test runner, and it is a function', () => {
    expect(park.front.deps.mergeTestRunner, 'the production root wired no merge-test runner at all').toBeTruthy()
    expect(typeof park.front.deps.mergeTestRunner).toBe('function')
  })

  /**
   * The second step: it ANSWERS LIKE A RUNNER. A tree with no target gets the runner's own
   * sentence about there being nothing to run — a shape no placeholder produces, and no test
   * is executed to get it, because the absence of the target is the whole answer.
   */
  it('the wired runner answers in its own words when the tree holds nothing to run', () => {
    const bare = mkdtempSync(join(tmpdir(), 'sma-merge-wire-bare-'))
    try {
      const answer: any = park.front.deps.mergeTestRunner({ cwd: bare })
      expect(answer.passed, 'an empty tree is not a red verdict').toBe(null)
      expect(answer.ran).toBe(false)
      expect(answer.note).toBe(NO_TARGET_NOTE)
      expect(answer.note).toContain(MERGE_SMOKE_TARGET)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  /**
   * THE CLAIM THIS FILE IS FOR — the argument travelled from the root into the ritual's call.
   *
   * The door's own closure is invoked over a throwaway repository, and the receipt is read.
   * Both worlds hand back `testsPassed: null`, and exactly ONE word tells them apart: with the
   * wire cut the ritual writes «прогонятель тестов не подключён», with the wire in place the
   * runner speaks for itself. Nothing here is faked — the closure, the git runner and the
   * runner inside it are the production ones; only the repository and the reservation
   * directories are temporary.
   */
  it('the door closure of a production daemon merges, and the RUNNER speaks in its receipt', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'sma-merge-wire-repo-'))
    const claimsDir = join(tmpRoot, 'claims-of-this-case')
    const journalDir = join(tmpRoot, 'journal-of-this-case')
    mkdirSync(claimsDir, { recursive: true })
    mkdirSync(journalDir, { recursive: true })
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    try {
      git(['init', '-q'])
      // Identity is set INSIDE the throwaway repository, never on the machine: the ritual's own
      // git runner commits without flags of its own, so the tree it acts in has to carry it.
      git(['config', 'user.email', 'suite@example.invalid'])
      git(['config', 'user.name', 'suite'])
      git(['config', 'commit.gpgsign', 'false'])
      writeFileSync(join(repo, 'a.txt'), 'a\n', 'utf8')
      git(['add', '--', 'a.txt'])
      git(['commit', '-q', '--no-verify', '-m', 'init'])
      const trunk = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()

      git(['checkout', '-q', '-b', 'feature-x'])
      writeFileSync(join(repo, 'b.txt'), 'b\n', 'utf8')
      git(['add', '--', 'b.txt'])
      git(['commit', '-q', '--no-verify', '-m', 'feat'])
      git(['checkout', '-q', trunk])

      // THE PRODUCTION CLOSURE, invoked exactly as the approval door invokes it — plus this
      // case's OWN reservation and journal directories, which is also how the options object
      // is proved to reach the ritual at all.
      const res: any = await park.front.deps.verbRunner({
        branch: 'feature-x',
        by: 'merge-wire-case',
        cwd: repo,
        claimsDir,
        journalDir,
      })

      expect(res.softDenied, 'this case took a foreign merge slot instead of its own').toBeFalsy()
      expect(res.ok, `the ritual failed outright: ${JSON.stringify(res)}`).not.toBe(false)
      expect(res.merged, 'a run that did not happen is not a refusal — the branch belongs in the tree').toBe(true)
      expect(res.testsPassed, 'no test ran in this tree, so there is no outcome to state').toBe(null)

      // ── THE WIRE. The receipt carries the RUNNER's sentence, not the ritual's «nobody wired
      //    me a runner». Cut the wire in the composition root and this line goes red.
      expect(res.testsNote, 'the production root handed the ritual no runner at all').not.toBe(NO_RUNNER_NOTE)
      expect(res.testsNote, `the word in the receipt did not come from the runner: ${res.testsNote}`).toBe(
        NO_TARGET_NOTE,
      )
      // …and it is the same sentence in the journalled receipt, not only in the return value.
      expect(res.receipt.testsNote).toBe(NO_TARGET_NOTE)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 180000)
})
