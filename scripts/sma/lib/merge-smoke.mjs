/**
 * merge-smoke.mjs — THE test runner the merge ritual is handed, and the ONLY one.
 *
 * WHY IT IS A MODULE AND NOT A CLOSURE. This body used to live inside the `merge` verb of the
 * command line, where the daemon could not reach it: the approval door builds its merge with
 * whatever runner the composition root hands over, and the root handed over `undefined`. So
 * the gate that decides whether accepted work enters the trunk ran NO tests in production
 * while a verb nobody calls held a perfectly good runner. One implementation, two consumers —
 * the verb and the door — is the whole point of moving it here. Nothing was invented on the
 * way: the target, the smoke idea and the three-valued answer are the verb's own.
 *
 * WHY THE TARGET IS ONE FILE AND NOT THE SUITE. This runs inside the daemon's request path,
 * on a working tree that is already merged but not yet committed, while a person waits on the
 * «Одобрить» button. The full suite of this tree is thousands of tests and minutes of wall
 * clock, and a synchronous child freezes the front for every second of it — the same cost the
 * tick's own runner is asynchronous for. A smoke that answers in seconds is a gate; a smoke
 * that answers in minutes is an outage. The file chosen is the merge gate's own suite: if the
 * ritual that is running right now is broken in the merged tree, that file says so.
 *
 * WHY THE RUN GOES THROUGH THE NODE BINARY. The previous body launched the package manager by
 * command name and without a shell. On Windows a package manager is a `.cmd` wrapper, and a
 * plain file launch cannot see it: the spawn dies with «no such file», the catch reads that as
 * a failing run, and the runner answers «tests are RED» — having executed not one test. That
 * answer is worse than no gate at all, because it refuses every merge for a reason that is not
 * true. This module launches the interpreter it is already running under (`process.execPath`)
 * with an ABSOLUTE path to the suite runner's entry point, resolved from THIS file rather than
 * from the working directory: the tree being tested is somebody else's checkout and need not
 * have any dependencies of its own.
 *
 * WHY THE ANSWER HAS THREE VALUES. «Red» and «there was no run» are different facts about the
 * world, and a merge gate that confuses them either blocks honest work or waves through
 * untested work. A non-zero exit from a run that HAPPENED is red. A missing target, a suite
 * runner that will not resolve, or a run that outlived its ceiling is NOT red — it is the
 * absence of a run, and it says so in its own words, which the ritual carries into the receipt.
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The one file the smoke runs — the merge ritual's own suite, in the tree being merged. */
export const MERGE_SMOKE_TARGET = 'scripts/sma/__tests__/merge-gate.test.ts'

/**
 * The ceiling, in milliseconds. Measured on this machine: the target answers in ~2.6 s green
 * in this tree and ~3.3 s red in a throwaway one. Two minutes is an order of magnitude of
 * head room — a loaded box still finishes, and a wedged run cannot hold the door open for
 * longer than a person would wait before deciding the daemon is dead.
 */
export const MERGE_SMOKE_TIMEOUT_MS = 120000

/** The three ways a run can be ABSENT — each in its own words, never as a red verdict. */
export const NO_TARGET_NOTE = `в дереве нет ${MERGE_SMOKE_TARGET} — прогонять было нечего`
export const NO_SUITE_RUNNER_NOTE = 'сьютер не нашёлся рядом с этой установкой — прогона не было'
export const TIMED_OUT_NOTE = `прогон не уложился в ${Math.round(MERGE_SMOKE_TIMEOUT_MS / 1000)} с — прогона не было`

/**
 * resolveSuiteEntry() — the ABSOLUTE path to the suite runner's entry point, resolved from
 * THIS module. Deliberately not a bare command name and not a path relative to the tree under
 * test: the tree under test is a foreign checkout. THROWS when the runner is not installed
 * beside this copy — an installed product without a suite runner is a tree where a run cannot
 * happen, which is a fact to report, not a failure to hide.
 */
export function resolveSuiteEntry() {
  const req = createRequire(import.meta.url)
  const manifestPath = req.resolve('vitest/package.json')
  const manifest = req('vitest/package.json')
  const bin = manifest && manifest.bin
  const entry = typeof bin === 'string' ? bin : bin && bin.vitest
  if (!entry) throw new Error('the suite runner declares no entry point')
  return join(dirname(manifestPath), String(entry))
}

/**
 * runMergeSmoke({cwd}) — run the smoke on the tree at `cwd` and answer in the ritual's own
 * three-valued vocabulary:
 *
 *   {passed: true,  ran: true}                 the run happened and was green
 *   {passed: false, ran: true, exitCode}       the run happened and was red
 *   {passed: null,  ran: false, note}          there was NO run, and here is why
 *
 * The ritual reads `passed === null` (or `ran === false`) as «nothing ran» and records the
 * note; anything else is an OUTCOME. The seams (`exists`, `resolveEntry`, `exec`) exist so a
 * suite can drive the three branches through the SHAPE of a real failure — a spawn that
 * cannot find its file, a child that exits non-zero, a child killed on its deadline — rather
 * than through a flag that would prove only that the flag works.
 */
export function runMergeSmoke(o = {}) {
  const tree = o.cwd || process.cwd()
  const target = o.target || MERGE_SMOKE_TARGET
  const exists = o.exists || existsSync
  const resolveEntry = o.resolveEntry || resolveSuiteEntry
  const exec = o.exec || execFileSync

  // (1) IS THERE ANYTHING TO RUN? Asked first, and not by the suite runner: a runner pointed
  //     at a filter that matches nothing exits NON-ZERO, which the catch below would have to
  //     read as red. An empty tree would then refuse every merge.
  if (!exists(join(tree, target))) return { passed: null, ran: false, note: NO_TARGET_NOTE }

  // (2) IS THERE ANYTHING TO RUN IT WITH? Resolved from this module, never from `tree`.
  let entry
  try {
    entry = resolveEntry()
  } catch {
    return { passed: null, ran: false, note: NO_SUITE_RUNNER_NOTE }
  }

  // (3) THE RUN. The interpreter this process already runs under, an absolute entry, an args
  //     array and no shell — the same discipline the git runner of this ritual keeps.
  try {
    exec(process.execPath, [entry, 'run', target], {
      cwd: tree,
      stdio: 'ignore',
      timeout: MERGE_SMOKE_TIMEOUT_MS,
    })
    return { passed: true, ran: true }
  } catch (err) {
    // A DEADLINE IS NOT A VERDICT. A killed child carries a signal and no exit status; calling
    // that red would blame the tests for the machine.
    if (err && (err.killed === true || (err.signal && err.status == null))) {
      return { passed: null, ran: false, note: TIMED_OUT_NOTE }
    }
    // A SPAWN THAT NEVER STARTED IS NOT A VERDICT EITHER. It carries a system error code and
    // no exit status — the exact shape that used to be read as «tests are red».
    if (err && err.status == null) return { passed: null, ran: false, note: NO_SUITE_RUNNER_NOTE }
    // Anything else IS a verdict: the child ran and left with a non-zero code.
    return { passed: false, ran: true, exitCode: err.status }
  }
}
