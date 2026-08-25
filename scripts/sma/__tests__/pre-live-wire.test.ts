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
 * IT WENT RED A SECOND TIME, AND THAT RED IS ALSO OVER. Demanding the restore point itself,
 * rather than a line about it, showed the snapshot breaking off before the doomed branch was
 * pinned: `git status --porcelain` collapses an untracked DIRECTORY into a single `?? dir/`
 * line, `git hash-object` exits 128 on a directory, and the exception left the snapshot
 * before the per-class pins ran. The case carried `it.fails` while that was the recorded
 * state of the product. The cure landed since: the untracked enumeration passes `-uall` so
 * directories arrive as files, and the capture step is guarded on its own so an unhashable
 * path degrades that step instead of aborting the snapshot. The mark is off, the assertions
 * were NOT relaxed, and the second case below holds the exact scene the defect lived in.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
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
   * THIS CASE WORE `it.fails` AND THE MARK IS OFF — THE DEFECT IT DECLARED IS FIXED.
   *
   * What was broken: `git status --porcelain` collapsed an untracked DIRECTORY into a
   * single `?? dir/` line, `git hash-object` exited 128 on it, and the untracked-capture
   * step of `takeSnapshot` — unguarded, unlike the per-class pin steps below it — took
   * the whole snapshot down before the doomed branch was pinned. A fresh `git init` has
   * no `.gitignore`, the airbag's own `.sma/` is therefore untracked, and this case hit
   * the defect on exactly that: the most ordinary tree there is, not a contrived corner.
   *
   * What cured it: the enumeration passes `-uall` (directories arrive as files) and the
   * capture step is guarded on its own (an unhashable path degrades that step, recorded
   * by name in the receipt, and the snapshot finishes its pins). Both assertions that
   * used to fail — `ok:true` and the pinned doomed branch — now hold as written; neither
   * was relaxed to get here. The case below this one keeps the untracked-directory scene
   * pinned explicitly, so the defect cannot return unnamed.
   */
  it('writes an airbag receipt for a branch delete, allows the command, and never fails the hook', () => {
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

    // …AND THE RESTORE POINT EXISTS. This is the assertion that once failed for a whole
    // release: the hook ran, said nothing, and wrote nothing, because the stream that
    // protects the work was behind a door the default left shut.
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

  /**
   * THE SCENE OF THE FIXED DEFECT, BUILT ON PURPOSE. The case above meets an untracked
   * directory by accident (`.sma/` appears in a fresh repository with no `.gitignore`);
   * this one lays the directory down deliberately, so the coverage does not hinge on
   * where the runtime happens to keep its state. A snapshot that meets `?? dir/` must
   * FINISH — hash the directory's files, pin the doomed branch, report ok — because a
   * tree with a new untracked folder in it is the most common tree there is.
   */
  it('finishes the snapshot over an untracked directory and pins the doomed branch', () => {
    const branch = `sma-airbag-dir-${Date.now()}`
    const repoDir = makeRepoWithDoomedBranch(branch)
    mkdirSync(join(repoDir, 'drafts'))
    writeFileSync(join(repoDir, 'drafts', 'note.txt'), 'not yet added\n')

    const frame = {
      session_id: 'pre-live-wire-untracked-dir',
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
    expect(res.status, `the hook exited ${res.status}; stderr: ${(res.stderr ?? '').slice(0, 600)}`).toBe(0)

    // The signature of the old defect, asserted absent at the source: git refusing a
    // directory fed to hash-object was the exact line the broken snapshot died on.
    expect(res.stderr ?? '').not.toContain('Unable to add')

    const receipts = journalRecords(repoDir).filter(
      (r) => r && r.type === 'airbag' && r.detail && r.detail.cmdClass === 'branch-delete',
    )
    expect(receipts.length, 'the hook ran over a destructive command and left no restore point').toBeGreaterThan(0)
    const detail = (receipts[0] ?? {}).detail ?? {}

    // The snapshot FINISHED: ok, the doomed branch pinned, and the directory's file
    // captured under the untracked tree — refs [head,branch] where the defect left [head].
    expect(
      detail.ok,
      `the snapshot did not complete: ok=${JSON.stringify(detail.ok)} refs=${JSON.stringify(detail.refs)}`,
    ).toBe(true)
    expect(
      (detail.refs ?? {}).branch,
      `only [${Object.keys(detail.refs ?? {}).join(',')}] was pinned — the deleted branch has no restore point`,
    ).toBeTruthy()
    expect(
      (detail.refs ?? {}).untracked,
      'the untracked directory contributed no pinned tree — its files were not captured',
    ).toBeTruthy()
    expect(Object.values(detail.indexPathMap ?? {})).toContain('drafts/note.txt')
  })
})
