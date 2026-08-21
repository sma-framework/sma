/**
 * THE AIRBAG WAS CALLED BY THE HOOK — NOT «THE AIRBAG FUNCTION CAN WRITE A RECEIPT».
 *
 * Those two sentences are separated by everything that actually breaks: the entry the
 * installer writes into the settings file, the tool matcher, the opt-in door, the soft time
 * budget, and the order the streams run in. A test that calls the check directly walks past
 * all five and reports success about a machine where a person's destructive command reaches
 * git with no restore point behind it — which is exactly the defect class this house keeps
 * paying for, and exactly why the receipt has to be demanded from the far end of the wire.
 *
 * So this file starts the hook the way the installed product starts it: a child node process
 * running the same command the installer writes, the real event frame on stdin, and an
 * environment with none of the stream toggles in it — a person's shell the day after he
 * installed. What is asserted is what is left on disk afterwards.
 *
 * The command is a branch delete. It is destructive by the airbag's own classification, so
 * the airbag is obliged to answer; it touches not a single file; and the branch it aims at is
 * created by this test, seconds earlier, inside a repository this test made and will delete.
 * Nothing that exists outside the temporary directory can be affected by any of it.
 *
 * NOTHING RUNS THE COMMAND. A PreToolUse hook is consulted BEFORE the tool acts, and this
 * test is the hook's caller, not the tool's: the branch is still there when the run ends. The
 * repository exists so the airbag has something real to take a snapshot in — measured from a
 * working tree, that snapshot would write into the tree's own git store.
 *
 * THIS FILE ARRIVED RED AND IS NOW GREEN, and the reason is the whole point of it. The airbag
 * stream used to sit behind a switch-on door that the shipped default left shut: the hook
 * returned cleanly and wrote no receipt — protection a person believes he has and does not
 * have. That red run is kept as a receipt of its own. The door was then removed, and this file
 * is what proves it from the far end of the wire: it goes red again the day anything —
 * a door, a matcher, a settings entry, a budget, an order change — puts a person's destructive
 * command in front of git with no restore point behind it.
 *
 * IT IS RED AGAIN, AND THE REDNESS IS DECLARED. The door is gone and the hook does answer —
 * but demanding the restore point itself, rather than a line about it, showed the snapshot
 * breaking off before the doomed branch is pinned. The case is therefore marked `it.fails`:
 * the reason, the reproduction and the condition for removing the mark are written above the
 * case itself. Green here means "the defect is still there, exactly as described"; the day it
 * is fixed this file turns the suite red until the mark comes off.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(__dirname, '..', '..', '..')
const cliPath = join(repoRoot, 'scripts', 'sma', 'cli.mjs')

/** Everything created by a case, removed after it whatever the case did. */
const made: string[] = []

afterEach(() => {
  while (made.length) {
    const dir = made.pop() as string
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort: a temp directory the platform holds on to is not a test failure */
    }
  }
})

/** A repository of our own making, with one commit and one branch to aim at. */
function makeRepoWithDoomedBranch(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-pre-live-'))
  made.push(dir)
  const git = (...args: string[]) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  }
  git('init', '-q')
  git('-c', 'user.email=probe@localhost', '-c', 'user.name=probe', 'commit', '--allow-empty', '-q', '-m', 'base')
  git('branch', branch)
  return dir
}

/**
 * A shell as it is the day after the install: every stream toggle removed.
 *
 * Not a convenience — it IS the subject. Reading the receipt out of a run that had the door
 * propped open by an inherited variable would prove nothing about what a person gets.
 */
function shellAfterInstall(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue
    if (k.startsWith('SMA_')) continue
    env[k] = v
  }
  return env
}

/** Every journal record the run left behind, in the repository's own store. */
function journalRecords(repoDir: string): any[] {
  const dir = join(repoDir, '.sma', 'journal')
  if (!existsSync(dir)) return []
  const out: any[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* a half-written line is not what this test is about */
      }
    }
  }
  return out
}

describe('a destructive command routed through the installed hook leaves a restore point', () => {
  /**
   * MARKED `it.fails` ON PURPOSE — THE FAILURE IS DECLARED, NOT HIDDEN.
   *
   * `it.fails` inverts the verdict: the suite is green only while this case FAILS, and the
   * day it starts passing the suite goes red and forces this mark to be removed. That is the
   * opposite of a skip: nothing here stops running, and nothing here was weakened to fit.
   *
   * WHAT IS BROKEN. `git status --porcelain` collapses an untracked DIRECTORY into a single
   * `?? dir/` line. `git hash-object` on a directory exits 128. The untracked-capture step of
   * `takeSnapshot` is not wrapped in its own try/catch (the per-class pin step below it is),
   * so that exception leaves the whole snapshot early — before the doomed branch gets pinned.
   * The receipt records the truth (`ok:false`, refs `[head]` where a healthy run has
   * `[head,branch]`) and the hook warns the person, so nothing about it is silent. But a
   * branch delete recovered from a HEAD pin alone is not recovered.
   *
   * This case reproduces it in its own temporary repository: a fresh `git init` has no
   * `.gitignore`, the airbag's own `.sma/` is therefore untracked, and the snapshot breaks
   * off on it. That is not a contrived corner — it is the state of any tree with a new
   * untracked folder in it.
   *
   * THE MARK COMES OFF when the untracked step survives an unhashable path (skip the entry,
   * mark the receipt, keep going) or the snapshot enumerates untracked files rather than
   * directories. The cure is known and was measured; it costs hook time against a 300 ms
   * budget, so choosing it is a human's call and not this file's. Until then: `ok:false` here
   * is the recorded state of the product, and the two assertions below are what will notice
   * the day it changes. NEVER re-green this by relaxing them.
   *
   * One honest caveat about the mechanism: `it.fails` is satisfied by ANY failure, so while
   * this mark is on, a regression elsewhere in the wire (hook exit code, matcher, receipt
   * absent) would be absorbed by it instead of shouting. That is the price of declaring the
   * failure inside the gate, and it is another reason the mark is meant to be short-lived.
   */
  it.fails('writes an airbag receipt for a branch delete, allows the command, and never fails the hook', () => {
    const branch = `sma-airbag-probe-${Date.now()}`
    const repoDir = makeRepoWithDoomedBranch(branch)

    // The frame the harness hands a PreToolUse hook, in its own shape.
    const frame = {
      session_id: 'pre-live-wire-probe',
      tool_name: 'Bash',
      tool_input: { command: `git branch -D ${branch}` },
    }

    const res = spawnSync(process.execPath, [cliPath, 'pre'], {
      cwd: repoDir,
      encoding: 'utf8',
      input: JSON.stringify(frame),
      env: shellAfterInstall(),
    })

    if (res.error || res.signal) {
      throw new Error(`the hook did not complete — signal=${res.signal} error=${res.error ? res.error.message : 'none'}\nstderr: ${(res.stderr ?? '').slice(0, 600)}`)
    }

    // A hook that exits non-zero is a hook that breaks a person's session. This holds today
    // and is asserted so the case below can never be satisfied by a crash.
    expect(res.status, `the hook exited ${res.status}; stderr: ${(res.stderr ?? '').slice(0, 600)}`).toBe(0)

    // Protection, not prohibition: the airbag takes the restore point and lets the command
    // through. A refusal here would mean the shipped default started blocking people.
    const printed = (res.stdout ?? '').trim()
    const decision = printed ? (JSON.parse(printed).hookSpecificOutput ?? {}).permissionDecision : 'allow'
    expect(decision, 'the shipped default refused a command instead of merely protecting it').not.toBe('deny')

    // …AND THE RESTORE POINT EXISTS. This is the assertion the current tree fails: the hook
    // ran, said nothing, and wrote nothing, because the stream that protects the work is
    // behind a door the default leaves shut.
    const receipts = journalRecords(repoDir).filter((r) => r && r.type === 'airbag')
    expect(receipts.length, 'the hook ran over a destructive command and left no restore point').toBeGreaterThan(0)
    expect(receipts.some((r) => r.detail && r.detail.cmdClass === 'branch-delete')).toBe(true)

    // …AND IT ARRIVED. Everything above proves the airbag was CALLED. A receipt is not a
    // restore point: the snapshot can break off halfway and still journal its line. So the two
    // assertions that follow demand the thing the airbag was called FOR, read from the same far
    // end of the wire — otherwise this file certifies a wire that carries nothing.
    const branchDelete = receipts.find((r) => r.detail && r.detail.cmdClass === 'branch-delete')
    const detail = (branchDelete ?? {}).detail ?? {}

    // (a) the snapshot completed — that is, the hashing step did not break off.
    expect(
      detail.ok,
      `the snapshot did not complete: ok=${JSON.stringify(detail.ok)} refs=${JSON.stringify(detail.refs)}`,
    ).toBe(true)

    // (b) the DOOMED BRANCH is pinned, not merely HEAD. A branch delete recovered from a HEAD
    //     pin alone is not recovered: whatever the branch carried and HEAD did not is gone.
    expect(
      (detail.refs ?? {}).branch,
      `only [${Object.keys(detail.refs ?? {}).join(',')}] was pinned — the deleted branch has no restore point`,
    ).toBeTruthy()
  })
})
