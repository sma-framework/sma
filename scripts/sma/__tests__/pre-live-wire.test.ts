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

    // …AND THE RESTORE POINT EXISTS. This is the assertion the current tree fails: the hook
    // ran, said nothing, and wrote nothing, because the stream that protects the work is
    // behind a door the default leaves shut.
    const receipts = journalRecords(repoDir).filter((r) => r && r.type === 'airbag')
    expect(receipts.length, 'the hook ran over a destructive command and left no restore point').toBeGreaterThan(0)
    expect(receipts.some((r) => r.detail && r.detail.cmdClass === 'branch-delete')).toBe(true)
  })
})
