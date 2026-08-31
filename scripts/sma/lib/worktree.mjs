/**
 * worktree.mjs — per-TERMINAL git worktree isolation.
 *
 * WHY THIS EXISTS
 * The founder runs MULTIPLE parallel Claude Code sessions against ONE checkout
 * that auto-deploys `main`. A parallel terminal's half-built work rides another
 * terminal's push (the recurring red-`main` failure). Per-terminal worktrees make
 * «your push carried my half-built work» PHYSICALLY impossible: each session gets
 * its own working directory + branch (`git worktree add <path> -b <branch>`), so two
 * sessions can never overwrite each other's files. Integration back to main is
 * SERIALIZED through the `sma merge` (local only); push stays founder-ordered
 * via /sma-ship. This module NEVER runs `git push` or `git merge`.
 *
 * THE MODEL IS PER-TERMINAL, NOT PER-PHASE OR EXECUTOR-ONLY
 * Three sessions sit on ONE phase today and the pain is human-driven parallel
 * sessions — so one worktree per TERMINAL is the model. Per-phase (too coarse — two
 * sessions on one phase still collide) and executor-only (misses the human-parallel
 * case entirely) are REJECTED.
 *
 * `.sma/` COORDINATION IS ALREADY WORKTREE-TRANSPARENT — NOT RE-PLUMBED
 * registry.smaRoot() resolves `.sma/` to the MAIN checkout via
 * `git rev-parse --git-common-dir`, so every worktree session ALREADY registers in
 * the shared checkout's `.sma/` — the fingerprint, claims, sessions, and journal
 * «just work» across worktrees for free. This module provisions WORKING-TREE directories
 * ONLY; it relies on that resolution and never re-implements coordination.
 *
 * THE SIBLING PRODUCT REPO RESOLVES FROM AN ABSOLUTE PATH
 * Scripts operating on `../sma/scripts/sma/**` from INSIDE a worktree cannot trust a
 * relative `../sma` (it may not point at the same place as the main checkout's). So
 * resolveSiblingRepo reads a recorded ABSOLUTE product-repo path in a FIXED order:
 *   env SMA_PRODUCT_REPO  →  a `.sma/` config value  →  the /sma-start profile's
 *   recorded path (via profile.mjs readProfile)  →  the relative `../sma` fallback.
 * Every miss degrades to the next source; the relative fallback stays for the primary
 * checkout. It reads profile.mjs read-only — it NEVER modifies the profile.
 *
 * THE TWO WINDOWS HAZARDS ARE STRUCTURALLY GUARDED
 *   - feedback_worktree_base_windows_bug (fired 3/4 in one project, 3/3 on 2026-07-03): a
 *     Windows worktree can branch from a commit OLDER than HEAD. provisionWorktree
 *     CAPTURES EXPECTED_BASE = `git rev-parse HEAD` at creation, VERIFIES the new
 *     worktree's base against it, and prefers `git reset --hard $EXPECTED_BASE`
 *     (never --soft) on a mismatch — never trusts creation.
 *   - feedback_worktree_shell_teleport: a teleported shell CWD runs git on the wrong
 *     branch. EVERY git call passes an EXPLICIT cwd via the injected execGit — NEVER a
 *     bare `cd <dir> && git ...` shell string. This is also what makes the unit tests
 *     mockable: they pass a recording double and never spawn a real `git worktree`.
 *
 * A COPY IS ONLY USEFUL IF IT CARRIES THE UNTRACKED LAYER TOO
 * `git worktree add` materializes exactly what git TRACKS. A project that keeps its
 * agent layer out of git — the rules file, the hooks, the memory notes, the local
 * settings — therefore hands an autonomous session a copy with none of it: no rules
 * read, nothing remembered, and a dependency tree it has to install from scratch
 * because that is ignored as well. So provisioning has two duties beyond `worktree
 * add`, both driven by a per-project manifest (`.sma/worktree-include`, a JSON
 * `{copy:[…], link:[…]}`; absent -> the documented defaults):
 *   COPY — the named untracked paths are copied in, file by file. A file git already
 *     tracks is left alone (git put it there); a file that is NEWER in the main tree
 *     is refreshed; a file that exists only in the copy — a lesson the session wrote
 *     itself — is never touched.
 *   LINK — the named dependency directories are attached by reference (a junction on
 *     Windows, a directory symlink elsewhere), never reinstalled. No package manager
 *     is ever invoked from here.
 * The manifest is project input, so it is treated as such: only relative paths, no
 * `..`, nothing under `.git`/`.sma`, and a SECRET blacklist by file name at any depth
 * that the manifest CANNOT override. Every decision — copied, linked, already tracked,
 * skipped and why — is reported back in `materialized[]`, because a provisioning step
 * whose choices are invisible cannot be audited from the attempt record afterwards.
 *
 * TEARDOWN UNHOOKS THE LINKS FIRST — THE ORDER IS LOAD-BEARING
 * Measured on Windows: `git worktree remove` FOLLOWS a junction and empties the
 * TARGET — the main checkout's dependency directory — with or without `--force`.
 * Removing the link itself first (`rmdirSync` on the link) leaves the target intact.
 * So any cleanup ritual built on top of this module must drop the links BEFORE it
 * lets git remove the copy. This module creates the links; the cleanup that consumes
 * this rule is the next step and lives beside `removeWorktree`.
 *
 * FAIL-OPEN (substrate law C9): every public entrypoint is wrapped so a provisioning
 * error degrades to an honest {ok:false, fellBackToPrimary:true, message} + the primary
 * checkout, never a wedged session and never a throw that escapes to the caller.
 *
 * BRIDGE POSTURE: worktree-per-terminal multiplayer
 * is vendor-absorbable (OpenAI acquired Multi in 2024) — a demolition clause with a
 * self-removal disposition, never headlined as a moat.
 *
 * DI CONVENTION (mirrors slots.mjs / registry.mjs): every git-touching function takes
 * an injectable `execGit(args, {cwd})` runner. The default real runner uses
 * execFileSync with an args ARRAY (no shell interpolation, no `cd`); tests pass a
 * recording double. Node built-ins only; zero npm deps.
 */

import { execFileSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { resolve as resolvePath, join as joinPath, dirname as dirnameOf, basename as basenameOf } from 'node:path'

import { WORKTREE_BRANCH_PREFIX } from './constants.mjs'

export { WORKTREE_BRANCH_PREFIX }

/**
 * Default real git runner: execFileSync with an args ARRAY + an EXPLICIT cwd. The
 * args-array form (never a shell string) makes the shell-teleport bug impossible —
 * there is no `cd &&` to teleport, and the cwd is passed to the child directly.
 * @param {string[]} args
 * @param {{cwd?:string}} [opts]
 * @returns {string}
 */
export function defaultExecGit(args, opts = {}) {
  return execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' })
}

/**
 * captureExpectedBase({execGit, cwd}) -> the trimmed `git rev-parse HEAD` at `cwd`.
 * Run in the MAIN checkout at provisioning time; the anchor the new worktree's base
 * is verified against (feedback_worktree_base_windows_bug).
 * @param {{execGit?:Function, cwd:string}} opts
 * @returns {string}
 */
export function captureExpectedBase(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  return String(execGit(['rev-parse', 'HEAD'], { cwd: opts.cwd })).trim()
}

/**
 * verifyWorktreeBase({execGit, cwd, expectedBase}) -> {matches, actual}. Reads the
 * NEW worktree's `git rev-parse HEAD` (at its own cwd) and compares to expectedBase.
 * @param {{execGit?:Function, cwd:string, expectedBase:string}} opts
 * @returns {{matches:boolean, actual:string}}
 */
export function verifyWorktreeBase(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  const actual = String(execGit(['rev-parse', 'HEAD'], { cwd: opts.cwd })).trim()
  return { matches: actual === opts.expectedBase, actual }
}

/**
 * THE COPY IS HANDED OVER WITHOUT AN ADDRESS TO PUSH TO — AND NOBODY'S REPOSITORY IS
 * RECONFIGURED BEHIND THEIR BACK.
 *
 * A worker session runs in a linked copy. Closing `git push` for it by pointing the
 * remote's PUSH address at a name that is not a repository (`no_push`) is the classic
 * move, and on a linked copy it is a trap: measured on git 2.53, `git config
 * remote.origin.pushurl no_push` executed INSIDE the copy lands in the SHARED config —
 * the one the MAIN checkout reads — so the person loses push at the same instant the
 * worker does. A defence that disarms the human is not a defence.
 *
 * Only ONE pair isolates it: the per-worktree config extension switched on in the main
 * tree, plus the `--worktree` flag on the write. Both halves are required; either alone
 * writes shared.
 *
 * AND THE EXTENSION IS NOT OURS TO SWITCH ON. Turning it on changes the meaning of
 * settings the repository ALREADY has — `core.bare` and `core.worktree` start being read
 * per-copy — so a product that flips it silently has edited the person's repository to
 * suit itself. This lock is the SECOND line of defence (the first is the refusal that
 * travels in the spawn arguments), and a second line has no right to gamble with the
 * first tree. So: where the extension is already on, the lock goes in; where it is not,
 * the copy is handed over WITHOUT the lock and the reason is said in words, in the
 * attempt record and on the card. Never a silent reconfiguration, never a silent skip.
 *
 * THE WRITE IS VERIFIED IMMEDIATELY, BY THIS CODE, NOT BY A LATER AUDIT. A lock nobody
 * checked is a lock on somebody else's door: right after writing, the shared config is
 * read again, and if the address leaked through, the write is taken back on BOTH sides
 * and the answer says the isolation did not hold. «Set it and hope» is the failure mode
 * this whole function exists to refuse.
 *
 * IT IS NOT A PROOF OF IMPOSSIBILITY, AND IT MUST NOT BE SOLD AS ONE. A worker holding
 * `Bash` can `git config --unset` it, or push to an explicit URL, or add a second remote.
 * Push is closed by THREE locks and not one of them is self-sufficient: the refusal in
 * the spawn arguments (the only one actually standing in the path), this address, and the
 * blocking hook on the classifier. This module says so out loud so no reader mistakes
 * depth for a guarantee.
 *
 * FAIL-OPEN like every neighbour here: no git error escapes, the copy is still handed
 * over, and the reason travels in the answer instead of becoming an exception.
 */

/** The address the copy's `origin` is pushed to — deliberately not a repository. */
export const PUSH_LOCK_URL = 'no_push'

/** Said in words wherever the lock is skipped, so the card never shows a bare `false`. */
export const PUSH_LOCK_NO_EXTENSION_REASON =
  'per-worktree config extension is not enabled in this repository — the lock is NOT installed ' +
  'and the repository is NOT reconfigured for it; push stays closed by the tool refusal in the spawn arguments'

/**
 * readGitConfig({execGit, cwd, args}) -> {value, missing, failed}. git answers exit 1 for
 * a key that is simply absent, which is an ANSWER, and any other failure is a genuine
 * fault — telling them apart is what keeps «no value» from being reported as «git broke».
 * @param {{execGit:Function, cwd:string, args:string[]}} opts
 * @returns {{value:string, missing:boolean, failed:boolean, error:string}}
 */
function readGitConfig({ execGit, cwd, args }) {
  try {
    return { value: String(execGit(args, { cwd })).trim(), missing: false, failed: false, error: '' }
  } catch (err) {
    const status = err && err.status
    if (status === 1) return { value: '', missing: true, failed: false, error: '' }
    return { value: '', missing: true, failed: true, error: String((err && err.message) || err) }
  }
}

/**
 * lockPushInCopy({execGit, mainRoot, copyPath}) — take the push address away from the
 * worker's copy WITHOUT taking it away from the person. Strict order, and every step may
 * refuse honestly:
 *   1. read the push address the MAIN tree effectively has. Already set by someone —
 *      leave it alone entirely (it is the person's setting, not ours to overwrite);
 *   2. read whether the per-worktree config extension is on. NOT on -> stop here with
 *      `applied:false` and the reason in words. We never switch it on ourselves;
 *   3. write `remote.origin.pushurl = no_push` into the COPY's own config (`--worktree`);
 *   4. re-read the shared config AT ONCE. Empty -> {applied:true, isolated:true}. Not
 *      empty -> undo on both sides and answer {applied:false, isolated:false}.
 * Every git call carries an EXPLICIT cwd (no `cd &&`), so a teleported shell cannot make
 * this run against the wrong tree.
 * @param {{execGit?:Function, mainRoot:string, copyPath:string}} opts
 * @returns {{applied:boolean, isolated:boolean, worktreeConfigPreset:(boolean|null),
 *            mainPushUrl:string, alreadyLocked?:boolean, reason:string}}
 */
export function lockPushInCopy(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  const { mainRoot, copyPath } = opts
  const PUSH_KEY = 'remote.origin.pushurl'
  try {
    // 1. WHAT THE PERSON ALREADY HAS. A push address someone configured by hand is a
    //    decision, and overwriting a decision to install a guard is the same sin as
    //    flipping the extension.
    const shared = readGitConfig({ execGit, cwd: mainRoot, args: ['config', '--get', PUSH_KEY] })
    if (shared.failed) {
      return {
        applied: false,
        isolated: false,
        worktreeConfigPreset: null,
        mainPushUrl: '',
        reason: `could not read the main tree's push address (${shared.error}) — the lock is not installed`,
      }
    }
    if (shared.value !== '') {
      return {
        applied: false,
        isolated: false,
        worktreeConfigPreset: null,
        mainPushUrl: shared.value,
        reason: 'a push address is already configured in this repository — left exactly as the person set it',
      }
    }

    // 2. IS THE ISOLATION AVAILABLE — asked, never arranged. This is the branch decided
    //    deliberately: no `git config extensions.worktreeConfig true` exists anywhere in
    //    this product, and a test asserts the ABSENCE of that command, not just this result.
    const ext = readGitConfig({ execGit, cwd: mainRoot, args: ['config', '--get', 'extensions.worktreeConfig'] })
    if (ext.failed) {
      return {
        applied: false,
        isolated: false,
        worktreeConfigPreset: null,
        mainPushUrl: '',
        reason: `could not read the per-worktree config extension (${ext.error}) — the lock is not installed`,
      }
    }
    if (ext.value.toLowerCase() !== 'true') {
      return {
        applied: false,
        isolated: false,
        worktreeConfigPreset: false,
        mainPushUrl: '',
        reason: PUSH_LOCK_NO_EXTENSION_REASON,
      }
    }

    // 2b. ALREADY LOCKED — a re-provisioned copy must cost nothing and must not report a
    //     write it did not make. Idempotence is checked by READING, so the second call
    //     leaves the recorder empty.
    const inCopy = readGitConfig({ execGit, cwd: copyPath, args: ['config', '--worktree', '--get', PUSH_KEY] })
    if (!inCopy.failed && inCopy.value === PUSH_LOCK_URL) {
      return {
        applied: true,
        isolated: true,
        alreadyLocked: true,
        worktreeConfigPreset: true,
        mainPushUrl: '',
        reason: 'the copy was already handed over without a push address — nothing rewritten',
      }
    }

    // 3. THE WRITE — into the COPY's own config, from the COPY's own directory.
    execGit(['config', '--worktree', PUSH_KEY, PUSH_LOCK_URL], { cwd: copyPath })

    // 4. AND IMMEDIATELY: DID IT STAY INSIDE? This is the step the whole function is built
    //    around. The measured failure mode is silent — the copy looks locked and the person
    //    finds out at their next push.
    const after = readGitConfig({ execGit, cwd: mainRoot, args: ['config', '--get', PUSH_KEY] })
    if (after.value !== '') {
      // Undo the person's side FIRST: their tree matters more than our guard.
      try {
        execGit(['config', '--unset', PUSH_KEY], { cwd: mainRoot })
      } catch {
        /* nothing left to unset is the outcome we wanted anyway */
      }
      try {
        execGit(['config', '--worktree', '--unset', PUSH_KEY], { cwd: copyPath })
      } catch {
        /* same: an absent key is the desired end state */
      }
      return {
        applied: false,
        isolated: false,
        worktreeConfigPreset: true,
        mainPushUrl: after.value,
        reason:
          'the isolation did not hold — the address appeared in the shared config, so it was taken back ' +
          'on both sides and the copy is handed over without the lock',
      }
    }

    return {
      applied: true,
      isolated: true,
      worktreeConfigPreset: true,
      mainPushUrl: '',
      reason: 'the copy has no address to push to; the main tree keeps its own',
    }
  } catch (err) {
    // FAIL-OPEN (substrate law C9): a copy without this second lock is still a usable copy,
    // and the first lock — the refusal in the spawn arguments — is untouched by this failure.
    return {
      applied: false,
      isolated: false,
      worktreeConfigPreset: null,
      mainPushUrl: '',
      reason: `push lock failed (${(err && err.message) || err}) — the copy is handed over without it`,
    }
  }
}

/**
 * provisionWorktree({branch, path, execGit, cwd}) — create a per-terminal worktree,
 * base-safe and teleport-safe. Sequence:
 *   1. capture EXPECTED_BASE = `git rev-parse HEAD` in the MAIN checkout (`cwd`);
 *   2. `git worktree add <path> -b <branch>` (from the main checkout `cwd`);
 *   3. verify the new worktree's base equals EXPECTED_BASE (rev-parse at `path`);
 *   4. on a MISMATCH, `git reset --hard <EXPECTED_BASE>` in the worktree's cwd
 *      (preferred over --soft — the working tree must match the new base on Windows).
 * EVERY execGit call passes an explicit cwd; there is no `cd &&` anywhere. Fail-open:
 * any git error returns {ok:false, fellBackToPrimary:true, message}, never throws.
 * @param {{branch:string, path:string, execGit?:Function, cwd:string}} opts
 * @returns {{ok:boolean, path?:string, branch?:string, expectedBase?:string,
 *            baseFixed?:boolean, actualBase?:string, fellBackToPrimary?:boolean, message?:string}}
 */
export function provisionWorktree(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  const { branch, path, cwd } = opts
  try {
    // 1. capture the anchor in the MAIN checkout BEFORE creating anything.
    const expectedBase = captureExpectedBase({ execGit, cwd })
    // 2. create the worktree + branch, run from the main checkout (explicit cwd).
    execGit(['worktree', 'add', path, '-b', branch], { cwd })
    // 3. verify the new tree branched from the anchor (Windows base bug).
    const { matches, actual } = verifyWorktreeBase({ execGit, cwd: path, expectedBase })
    let baseFixed = false
    if (!matches) {
      // 4. hard-reset the worktree onto the anchor (never --soft) — in the worktree cwd.
      execGit(['reset', '--hard', expectedBase], { cwd: path })
      baseFixed = true
    }
    // 5. AND THE COPY LOSES ITS ADDRESS TO PUSH TO — where, and only where, the person has
    //    already switched the per-worktree config extension on. See lockPushInCopy: the naive
    //    write takes push away from the MAIN tree, and we never flip that extension ourselves.
    const pushLock = lockPushInCopy({ execGit, mainRoot: cwd, copyPath: path })
    return { ok: true, path, branch, expectedBase, baseFixed, actualBase: actual, pushLock }
  } catch (err) {
    return {
      ok: false,
      fellBackToPrimary: true,
      message: `worktree provisioning failed (${err && err.message}) — staying on the primary checkout`,
    }
  }
}

/**
 * listWorktrees({execGit, cwd}) -> [{path, head, branch}]. Parses
 * `git worktree list --porcelain` deterministically (blank-line-separated blocks;
 * `worktree <path>` / `HEAD <sha>` / `branch <ref>` lines). Fail-open -> [].
 * @param {{execGit?:Function, cwd:string}} opts
 * @returns {{path:string, head:string, branch:string}[]}
 */
export function listWorktrees(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  try {
    const out = String(execGit(['worktree', 'list', '--porcelain'], { cwd: opts.cwd }))
    const trees = []
    let cur = null
    for (const raw of out.replace(/\r\n/g, '\n').split('\n')) {
      const line = raw.trim()
      if (line === '') {
        if (cur) trees.push(cur)
        cur = null
        continue
      }
      if (line.startsWith('worktree ')) {
        if (cur) trees.push(cur)
        cur = { path: line.slice('worktree '.length).trim(), head: '', branch: '' }
      } else if (cur && line.startsWith('HEAD ')) {
        cur.head = line.slice('HEAD '.length).trim()
      } else if (cur && line.startsWith('branch ')) {
        cur.branch = line.slice('branch '.length).trim()
      }
    }
    if (cur) trees.push(cur)
    return trees
  } catch {
    return [] // git absent / not a repo -> honest empty list, never a throw
  }
}

/** True when a listed worktree entry corresponds to the requested branch or path. */
function matchesTree(entry, { branch, path }) {
  if (path && entry.path === path) return true
  if (!branch) return false
  const short = branch.replace(/^refs\/heads\//, '')
  const entryShort = (entry.branch || '').replace(/^refs\/heads\//, '')
  return entry.branch === branch || entryShort === short
}

/**
 * reuseOrProvision({branch, path, execGit, cwd}) — idempotent provisioning. Returns
 * the EXISTING worktree (from `git worktree list`) when one already matches the branch
 * or path (no duplicate `worktree add`); otherwise provisions a fresh one with the
 * base guard. Fail-open via provisionWorktree.
 * @param {{branch:string, path:string, execGit?:Function, cwd:string}} opts
 * @returns {object}
 */
export function reuseOrProvision(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  const { branch, path, cwd } = opts
  const existing = listWorktrees({ execGit, cwd }).find((e) => matchesTree(e, { branch, path }))
  if (existing) {
    // THE REUSED COPY GETS THE SAME LOCK. A copy provisioned before this existed, or one whose
    // lock a session removed, would otherwise come back with push open — and the reuse path is
    // the one a retry takes, which is exactly when nobody is looking. lockPushInCopy is
    // idempotent by reading, so a copy already locked costs a read and no write.
    const pushLock = lockPushInCopy({ execGit, mainRoot: cwd, copyPath: existing.path })
    return { ok: true, reused: true, path: existing.path, branch: existing.branch, head: existing.head, pushLock }
  }
  return { ...provisionWorktree({ branch, path, execGit, cwd }), reused: false }
}

/**
 * removeWorktree({path, execGit, cwd, force}) — `git worktree remove <path>` with an
 * EXPLICIT cwd. `--force` is added ONLY when `force:true` (git itself refuses a dirty
 * tree without it — that guard is preserved by not adding the flag by default).
 * Fail-open -> {ok:false, message}.
 *
 * RAW, AND THEREFORE ONLY FOR A COPY WITH NOTHING LINKED INSIDE IT. Provisioning now
 * attaches the dependency tree by reference, so most copies DO carry links — and git,
 * meeting one, walks INTO it and empties the TARGET directory in the main checkout
 * (measured on Windows, with and without `--force`). For anything a provision produced,
 * use removeWorktreeSafely: it unhooks the links first, so git never meets one.
 * @param {{path:string, execGit?:Function, cwd:string, force?:boolean}} opts
 * @returns {{ok:boolean, removed?:string, message?:string}}
 */
export function removeWorktree(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  const { path, cwd, force } = opts
  try {
    const args = ['worktree', 'remove', path]
    if (force) args.push('--force')
    execGit(args, { cwd })
    return { ok: true, removed: path }
  } catch (err) {
    return { ok: false, message: `worktree remove failed (${err && err.message})` }
  }
}

// ─── removing a copy: unhook the links FIRST, then let git have it ───────────

/**
 * samePathOs(a, b) — path equality that survives what this platform actually hands out.
 * On Windows the temp root arrives as an 8.3 short name (`C:\Users\JUNIS~1\…`) while git
 * records the long form, separators disagree, and the file system is case-insensitive.
 * Comparing raw strings would let a legitimate copy look like a stranger — and this
 * comparison is the only thing standing between a command-line argument and a recursive
 * delete, so it resolves both sides through the file system when it can.
 * @param {string} a
 * @param {string} b
 * @param {object} [fs]
 * @param {string} [platform]
 * @returns {boolean}
 */
function samePathOs(a, b, fs = nodeFs, platform = process.platform) {
  const real = (p) => {
    try {
      const native = fs && fs.realpathSync && fs.realpathSync.native
      if (typeof native === 'function') return native(String(p))
      if (fs && typeof fs.realpathSync === 'function') return fs.realpathSync(String(p))
    } catch {
      /* the path may not exist (an unregistered argument) — fall back to resolution */
    }
    return resolvePath(String(p))
  }
  const norm = (p) => {
    const s = real(p).replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/**
 * unlinkLinksIn({copyPath, fsImpl}) -> [{path, target, error?}] — remove every link
 * INSIDE a copy without following a single one of them.
 *
 * `rmdirSync`/`unlinkSync` on a link delete the LINK; the target is untouched. The walk
 * tests `isSymbolicLink()` BEFORE `isDirectory()`, so it never descends through a link
 * into the main checkout, and it never enters `.git`. A link that refuses to come off is
 * recorded with its error and the walk continues — one stubborn link must not leave the
 * remaining ones in place, because the next step hands the copy to git.
 * @param {{copyPath:string, fsImpl?:object}} opts
 * @returns {Array<{path:string, target:string|null, error?:string}>}
 */
export function unlinkLinksIn(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const unlinked = []
  walkLinks(fs, opts.copyPath, ({ abs, path, target }) => {
    try {
      try {
        fs.rmdirSync(abs) // a directory link (junction on Windows)
      } catch {
        fs.unlinkSync(abs) // a file link
      }
      unlinked.push({ path, target })
    } catch (err) {
      unlinked.push({ path, target, error: String((err && err.message) || err) })
    }
  })
  return unlinked
}

/**
 * walkLinks(fs, root, visit) — every link inside a copy, and NEVER a step through one.
 *
 * `isSymbolicLink()` is tested BEFORE `isDirectory()`, which is the whole safety of the
 * walk: a junction reports as a directory to anything that asks the second question
 * first, and the walk would then be inside the MAIN checkout, deleting its files while
 * believing it is inside a copy. `.git` is never entered. An unreadable directory ends
 * that branch and nothing else — one bad corner must not hide the remaining links from
 * the caller, because the caller is about to decide whether git may have the copy.
 * @param {object} fs
 * @param {string} root
 * @param {(link:{abs:string, path:string, target:(string|null)}) => void} visit
 */
function walkLinks(fs, root, visit) {
  const walk = (dir, rel) => {
    let items
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // an unreadable directory is not a reason to abandon the rest
    }
    for (const it of items) {
      if (it.name === '.git') continue
      const abs = joinPath(dir, it.name)
      const relPath = rel ? `${rel}/${it.name}` : it.name
      if (it.isSymbolicLink()) {
        let target = null
        try {
          target = String(fs.readlinkSync(abs))
        } catch {
          /* an unreadable target does not make it any less of a link */
        }
        visit({ abs, path: relPath, target })
      } else if (it.isDirectory()) {
        walk(abs, relPath)
      }
    }
  }
  walk(root, '')
}

/**
 * linksRemainingIn({copyPath, fsImpl}) -> [{path, target}] — what is STILL attached by
 * reference inside a copy. Asked AFTER the unhooking, and the answer decides whether the
 * copy may be handed on: one link that refused to come off is enough for git to walk into
 * the main checkout and empty the directory the founder is working in (measured 31.08.2026
 * — a raw `git worktree remove --force` on a copy with three live junctions).
 * @param {{copyPath:string, fsImpl?:object}} opts
 * @returns {Array<{path:string, target:string|null}>}
 */
export function linksRemainingIn(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const remaining = []
  walkLinks(fs, opts.copyPath, ({ path, target }) => remaining.push({ path, target }))
  return remaining
}

/**
 * rmInsideOnly({root, fsImpl}) -> {files, dirs, links} — recursive removal with a STRICT
 * BOUNDARY at its own directory.
 *
 * Every entry is `lstat`ed and a link is UNLINKED, never entered: the deletion therefore
 * cannot leave `root`, whatever is attached inside it. `fs.rmSync(…, {recursive:true})`
 * behaves the same way today — this exists because that is a promise of somebody else's
 * implementation on a platform where a junction answers `isDirectory()` with `true`, and
 * the thing it protects is the founder's dependency tree. Throws on failure: the caller
 * (removeWorktreeSafely) already treats an impossible removal as an honest answer.
 * @param {{root:string, fsImpl?:object}} opts
 * @returns {{files:number, dirs:number, links:number}}
 */
export function rmInsideOnly(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const counts = { files: 0, dirs: 0, links: 0 }
  const remove = (dir) => {
    let items
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      items = []
    }
    for (const it of items) {
      const abs = joinPath(dir, it.name)
      if (it.isSymbolicLink()) {
        try {
          fs.rmdirSync(abs) // a directory link (junction on Windows)
        } catch {
          fs.unlinkSync(abs) // a file link
        }
        counts.links += 1
        continue
      }
      if (it.isDirectory()) {
        remove(abs)
        continue
      }
      try {
        fs.unlinkSync(abs)
      } catch {
        // A read-only or momentarily locked file — git's own objects are both. The entry
        // has already been proven NOT to be a link, so the retrying removal cannot leave
        // this directory either.
        fs.rmSync(abs, { force: true, maxRetries: 3 })
      }
      counts.files += 1
    }
    try {
      fs.rmdirSync(dir)
    } catch {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
    counts.dirs += 1
  }
  remove(opts.root)
  return counts
}

/**
 * dirtyFilesOf({path, execGit}) -> the paths `git status --porcelain` reports in a copy.
 * This is the list of what a forced removal is about to destroy, so the caller can put it
 * into the record instead of discovering it afterwards. Fail-open -> [].
 * @param {{path:string, execGit?:Function}} opts
 * @returns {string[]}
 */
export function dirtyFilesOf(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  try {
    const out = String(execGit(['status', '--porcelain'], { cwd: opts.path }))
    return out
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
  } catch {
    return [] // no git, no copy, no answer — an empty list, never a throw
  }
}

/**
 * removeWorktreeSafely({path, cwd, execGit, fsImpl, force, deleteBranch}) — the only
 * cleanup a provisioned copy may go through.
 *
 * THE ORDER IS THE WHOLE FUNCTION:
 *   0. REFUSE first. Nothing is deleted until the path is proven to be a linked copy of
 *      THIS repository and not the main checkout. A typo in an argument otherwise costs
 *      the developer's working tree, and the previous step (unhooking links) is itself
 *      destructive — so it may not run before the refusal.
 *   1. Unhook every link inside the copy. git walks into them; Node does not.
 *   1a. LOOK AGAIN. A link that refused to come off is a refusal to continue, not a note
 *      in the answer: git meeting it empties the target in the main checkout.
 *   2. Read what is about to be lost (`git status --porcelain`) into the answer.
 *   3. `git worktree remove <path> [--force]`.
 *   4. If git refused and the caller asked for force, finish by hand with the
 *      strict-boundary removal (rmInsideOnly) and `git worktree prune` so the list of
 *      trees stays honest — reported as `fallback:'rm+prune'` rather than passed off as
 *      a clean git removal.
 *   5. Optionally delete the branch the copy stood on, recording its tip FIRST, so the
 *      work remains reachable through the reflog and the record says where it was.
 * A failed branch deletion does not turn a successful removal into a failure; it is
 * reported as `branchDeleted:false` with the reason.
 * @param {{path:string, cwd:string, execGit?:Function, fsImpl?:object, platform?:string,
 *          force?:boolean, deleteBranch?:boolean}} opts
 * @returns {{ok:boolean, removed?:string, unlinked?:Array, linksRemaining?:Array,
 *            dirtyFiles?:string[], forced?:boolean, fallback?:string|null,
 *            branch?:string|null, branchDeleted?:boolean, branchTip?:string|null,
 *            branchError?:string, message?:string}}
 */
export function removeWorktreeSafely(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  const fs = opts.fsImpl ?? nodeFs
  const platform = opts.platform ?? process.platform
  const { path, cwd, force, deleteBranch } = opts

  if (!path) return { ok: false, message: 'уборка отменена: путь копии не назван' }

  // ── (0) refuse before touching anything ────────────────────────────────────
  const trees = listWorktrees({ execGit, cwd })
  const mainTree = trees.length > 0 ? trees[0].path : null
  if (samePathOs(path, cwd, fs, platform) || (mainTree && samePathOs(path, mainTree, fs, platform))) {
    return { ok: false, message: `уборка отменена: ${path} — основное дерево репозитория, а не копия` }
  }
  const entry = trees.find((t) => samePathOs(t.path, path, fs, platform))
  if (!entry) {
    return { ok: false, message: `уборка отменена: ${path} не зарегистрирован как рабочая копия этого репозитория` }
  }
  const branch = String(entry.branch || '').replace(/^refs\/heads\//, '') || null

  // ── (1) links off, (1a) PROVEN off, (2) losses written down ────────────────
  const unlinked = unlinkLinksIn({ copyPath: path, fsImpl: fs })

  // The unhooking used to be trusted on its word: a link that refused to come off was
  // written into the answer and the copy was handed to git anyway — and git, meeting the
  // survivor, walks INTO it and empties the target in the main checkout. So the copy is
  // LOOKED AT again, and one surviving link is a refusal: a copy left on disk costs a
  // directory, a copy handed on costs the founder's dependency tree (measured 31.08.2026).
  const remaining = linksRemainingIn({ copyPath: path, fsImpl: fs })
  if (remaining.length) {
    const named = remaining.map((l) => `${l.path}${l.target ? ` → ${l.target}` : ''}`).join(', ')
    return {
      ok: false,
      message:
        `уборка отменена: в копии остались ссылки (${named}) — снять их не удалось. ` +
        'Отдать копию git с живой ссылкой значит опустошить каталог-цель в основном дереве: ' +
        'снимите ссылки вручную (`rm <ссылка>` снимает саму ссылку, цель не трогает) и повторите.',
      unlinked,
      linksRemaining: remaining,
    }
  }

  const dirtyFiles = dirtyFilesOf({ path, execGit })

  // ── (3) git removes the copy; (4) or we finish by hand ─────────────────────
  let fallback = null
  try {
    const args = ['worktree', 'remove', path]
    if (force) args.push('--force')
    execGit(args, { cwd })
  } catch (err) {
    if (!force) {
      return {
        ok: false,
        message: `git отказался убрать копию (${err && err.message}); повторите с принудительной уборкой, если потери допустимы`,
        unlinked,
        dirtyFiles,
      }
    }
    try {
      // The hand finish uses the STRICT-BOUNDARY removal, not a plain recursive one: at
      // this point git has already refused, and the last thing this path may do is follow
      // something out of the copy. rmInsideOnly unlinks a link and never enters it.
      rmInsideOnly({ root: path, fsImpl: fs })
      try {
        execGit(['worktree', 'prune'], { cwd })
      } catch {
        /* the copy is gone; a stale registration is a smaller problem than a throw */
      }
      fallback = 'rm+prune'
    } catch (err2) {
      return {
        ok: false,
        message: `копию не убрал ни git, ни прямое удаление (${err2 && err2.message})`,
        unlinked,
        dirtyFiles,
      }
    }
  }

  // ── (5) the branch, with its tip written down before it goes ───────────────
  let branchDeleted = false
  let branchTip = null
  let branchError = null
  if (deleteBranch && branch) {
    try {
      branchTip = String(execGit(['rev-parse', branch], { cwd })).trim()
    } catch {
      /* an unreadable tip is not a reason to keep the branch — the reflog still has it */
    }
    try {
      execGit(['branch', '-D', branch], { cwd })
      branchDeleted = true
    } catch (err) {
      branchError = `ветку ${branch} снять не удалось (${err && err.message})`
    }
  }

  const res = {
    ok: true,
    removed: path,
    unlinked,
    dirtyFiles,
    forced: !!force,
    fallback,
    branch,
    branchDeleted,
    branchTip,
  }
  if (branchError) res.branchError = branchError
  return res
}

// ─── the untracked layer: manifest, copy, link ───────────────────────────────

/** Where a project declares what its working copies must carry beyond git. */
export const WORKTREE_INCLUDE_FILE = '.sma/worktree-include'

/**
 * What a copy carries when the project says nothing: the agent layer in both places
 * the harness looks for it, the local settings file (usually ignored, and the reason
 * `settings.local.json` is named explicitly rather than assumed inside the directory),
 * and the dependency tree by reference.
 */
export const DEFAULT_WORKTREE_INCLUDE = Object.freeze({
  copy: Object.freeze(['.claude/', 'CLAUDE.md', '.claude/settings.local.json']),
  link: Object.freeze(['node_modules']),
})

/**
 * The ONLY shape a manifest may attach by reference: a dependency directory
 * (node_modules at any depth). Everything else under `link` is treated as
 * writable and travels as a copy instead — see the link loop in
 * materializeInclude for why a junction to a rebuildable directory pierces the
 * attempt's isolation.
 */
const DEPENDENCY_LINK_RE = /(^|\/)node_modules$/

/**
 * Never carried, whatever the manifest says: git's own directory and the coordination
 * directory (runtime state of the MAIN checkout — a copy that inherits it would
 * register as the main checkout), plus the scheduler lock, which is a live-process
 * artefact and means nothing in a copy.
 */
export const NEVER_COPY = Object.freeze(['.git', '.sma', '.claude/scheduled_tasks.lock'])

/**
 * Secret file names, matched on the BASE NAME at any depth — a manifest cannot
 * override them, because the whole point is that the person writing the manifest is
 * not necessarily the person whose credentials sit in the tree.
 */
export const SECRET_NAME_PATTERNS = Object.freeze([
  /^\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^\.secrets/i,
])

/** Forward slashes, no trailing separator — the one shape paths travel in here. */
function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

/** True when the file NAME (at any depth) looks like a credential. */
function isSecretName(name) {
  return SECRET_NAME_PATTERNS.some((re) => re.test(String(name)))
}

/** True when a repo-relative path is, or sits under, something never carried. */
function isNeverCopied(rel) {
  const r = normalizeRel(rel)
  return NEVER_COPY.some((n) => r === n || r.startsWith(`${n}/`))
}

/** Case-insensitive on Windows; `p` must be `root` itself or sit under it. */
function isInside(root, p, platform) {
  const norm = (v) => {
    const s = resolvePath(String(v)).replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' ? s.toLowerCase() : s
  }
  const r = norm(root)
  const t = norm(p)
  return t === r || t.startsWith(`${r}/`)
}

/**
 * One manifest list, validated. A path survives only if it is a non-empty RELATIVE
 * path with no `..` segment and no `.git`/`.sma` first segment; everything else is
 * dropped with a warning rather than silently, so a typo in a project file is visible
 * in the provisioning answer instead of quietly carrying nothing.
 */
function sanitizeList(value, label, warnings) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    warnings.push(`манифест: ключ «${label}» — не список, пропущен`)
    return []
  }
  const out = []
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) {
      warnings.push(`манифест «${label}»: пустая или нестроковая запись пропущена`)
      continue
    }
    const rel = normalizeRel(raw.trim())
    if (/^([A-Za-z]:)?\//.test(rel) || rel.startsWith('~')) {
      warnings.push(`манифест «${label}»: абсолютный путь «${raw}» отброшен`)
      continue
    }
    const segments = rel.split('/')
    if (segments.some((s) => s === '..')) {
      warnings.push(`манифест «${label}»: путь наружу «${raw}» отброшен`)
      continue
    }
    if (segments[0] === '.git' || segments[0] === '.sma') {
      warnings.push(`манифест «${label}»: служебный путь «${raw}» отброшен`)
      continue
    }
    out.push(raw.trim())
  }
  return out
}

/**
 * readWorktreeInclude({mainRoot, fsImpl}) -> {source, copy, link, warnings}.
 * `source` is 'file' when the project declared its own list, 'invalid' when it tried
 * and the file could not be read as an object (the DEFAULTS still apply — a broken
 * project file must not cost the session its rules), 'default' when there is no file.
 * Never throws.
 * @param {{mainRoot:string, fsImpl?:object}} opts
 * @returns {{source:('default'|'file'|'invalid'), copy:string[], link:string[], warnings:string[]}}
 */
export function readWorktreeInclude(opts = {}) {
  const fs = opts.fsImpl ?? nodeFs
  const warnings = []
  const defaults = () => ({
    copy: [...DEFAULT_WORKTREE_INCLUDE.copy],
    link: [...DEFAULT_WORKTREE_INCLUDE.link],
  })
  const file = joinPath(opts.mainRoot ?? '.', ...WORKTREE_INCLUDE_FILE.split('/'))
  let raw
  try {
    raw = String(fs.readFileSync(file, 'utf8'))
  } catch {
    return { source: 'default', ...defaults(), warnings } // no file -> the documented defaults
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    warnings.push(`манифест ${WORKTREE_INCLUDE_FILE} не разобран (${err && err.message}) — действуют умолчания`)
    return { source: 'invalid', ...defaults(), warnings }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`манифест ${WORKTREE_INCLUDE_FILE}: ожидался объект {copy, link} — действуют умолчания`)
    return { source: 'invalid', ...defaults(), warnings }
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'copy' && key !== 'link') warnings.push(`манифест: неизвестный ключ «${key}» пропущен`)
  }
  return {
    source: 'file',
    copy: sanitizeList(parsed.copy, 'copy', warnings),
    link: sanitizeList(parsed.link, 'link', warnings),
    warnings,
  }
}

/**
 * trackedSetOf({mainRoot, execGit}) -> Set of repo-relative paths git tracks. ONE
 * `ls-files` call answers the copy/tracked question for every file below, which is
 * what makes a mixed directory (mostly tracked, one ignored local file) come out
 * right. Fail-open -> an empty set, i.e. "copy it", which is the safe direction.
 * @param {{mainRoot:string, execGit?:Function}} opts
 * @returns {Set<string>}
 */
export function trackedSetOf(opts = {}) {
  const execGit = opts.execGit ?? defaultExecGit
  const set = new Set()
  try {
    const out = String(execGit(['ls-files', '-z'], { cwd: opts.mainRoot }))
    for (const raw of out.split('\0')) {
      const p = normalizeRel(raw).trim()
      if (p) set.add(p)
    }
  } catch {
    /* git absent / not a repo -> nothing known tracked */
  }
  return set
}

/** Copy one manifest entry into the copy, file by file. Never throws. */
function materializeCopyEntry(entry, ctx) {
  const { fs, mainRoot, copyPath, trackedLazy } = ctx
  const rel = normalizeRel(entry)
  if (isSecretName(basenameOf(rel))) return { path: entry, mode: 'skipped', reason: 'secret' }
  if (isNeverCopied(rel)) return { path: entry, mode: 'skipped', reason: 'never' }

  const src = joinPath(mainRoot, ...rel.split('/'))
  const dst = joinPath(copyPath, ...rel.split('/'))
  let copied = 0
  let tracked = 0
  let current = 0
  let bytes = 0
  const skipped = []

  const stack = [{ s: src, d: dst, r: rel }]
  while (stack.length) {
    const cur = stack.pop()
    let st
    try {
      st = fs.lstatSync(cur.s)
    } catch {
      continue // vanished between readdir and stat — nothing to carry
    }
    if (st.isSymbolicLink()) {
      // A link inside a copied tree is never followed: it could leave the tree entirely.
      skipped.push({ path: cur.r, reason: 'link' })
      continue
    }
    if (isSecretName(basenameOf(cur.r))) {
      skipped.push({ path: cur.r, reason: 'secret' })
      continue
    }
    if (isNeverCopied(cur.r)) {
      skipped.push({ path: cur.r, reason: 'never' })
      continue
    }
    if (st.isDirectory()) {
      let items
      try {
        items = fs.readdirSync(cur.s, { withFileTypes: true })
      } catch {
        continue
      }
      for (const it of items) {
        stack.push({
          s: joinPath(cur.s, it.name),
          d: joinPath(cur.d, it.name),
          r: cur.r ? `${cur.r}/${it.name}` : it.name,
        })
      }
      continue
    }
    if (!st.isFile()) continue
    if (trackedLazy().has(cur.r)) {
      tracked++ // git already put this file in the copy — touching it would fight git
      continue
    }
    let dstStat = null
    try {
      dstStat = fs.statSync(cur.d)
    } catch {
      /* not in the copy yet */
    }
    // "Newer" needs a one-millisecond floor. Copying carries the source timestamp
    // across, but the round trip through the timestamp API loses the sub-millisecond
    // part (measured: ~0.1 ms), so a strict `>` reports EVERY file as newer forever —
    // the copy would be rewritten wholesale on every visit and the reported mode would
    // claim work that never happened. A real edit is orders of magnitude further away.
    if (dstStat && st.mtimeMs - dstStat.mtimeMs <= 1) {
      current++ // the copy is not older — leave it, it may be the session's own edit
      continue
    }
    try {
      fs.mkdirSync(dirnameOf(cur.d), { recursive: true })
      fs.copyFileSync(cur.s, cur.d)
      // Carry the source timestamp across so the next visit can compare honestly.
      try {
        fs.utimesSync(cur.d, st.atime, st.mtime)
      } catch {
        /* a filesystem that refuses timestamps still gets the content */
      }
      copied++
      bytes += st.size || 0
    } catch (err) {
      skipped.push({ path: cur.r, reason: `error: ${err && err.message}` })
    }
  }

  // 'absent' means nothing was found at all. A path that is fully in place already is
  // reported as carried with a count of zero — calling that 'absent' would be a lie in
  // the attempt record, which is the one place this answer is read months later.
  let mode = 'absent'
  if (copied > 0) mode = 'copy'
  else if (tracked > 0) mode = 'tracked'
  else if (current > 0) mode = 'copy'
  const record = { path: entry, mode, files: copied, tracked, current, bytes }
  if (skipped.length) record.skipped = skipped
  return record
}

/** Attach one manifest entry by reference. Never throws. */
function materializeLinkEntry(entry, ctx) {
  const { fs, mainRoot, copyPath, platform } = ctx
  const rel = normalizeRel(entry)
  if (isSecretName(basenameOf(rel))) return { path: entry, mode: 'skipped', reason: 'secret' }
  if (isNeverCopied(rel)) return { path: entry, mode: 'skipped', reason: 'never' }

  // A junction needs an ABSOLUTE target, and the target must sit inside the main tree —
  // a link is a doorway, and this one only ever opens onto the project it belongs to.
  const target = resolvePath(mainRoot, ...rel.split('/'))
  if (!isInside(mainRoot, target, platform)) return { path: entry, mode: 'skipped', reason: 'outside' }
  try {
    fs.lstatSync(target)
  } catch {
    return { path: entry, mode: 'absent' }
  }

  const dst = joinPath(copyPath, ...rel.split('/'))
  let dstStat = null
  try {
    dstStat = fs.lstatSync(dst)
  } catch {
    /* free slot */
  }
  if (dstStat) {
    if (dstStat.isSymbolicLink()) return { path: entry, mode: 'link', existing: true, target }
    // A real directory here is somebody's real work (an older copy that installed its
    // own). Replacing it would delete it; saying so is the honest move.
    return { path: entry, mode: 'skipped', reason: 'exists' }
  }
  try {
    fs.mkdirSync(dirnameOf(dst), { recursive: true })
    fs.symlinkSync(target, dst, platform === 'win32' ? 'junction' : 'dir')
    return { path: entry, mode: 'link', target }
  } catch (err) {
    return { path: entry, mode: 'skipped', reason: `error: ${err && err.message}` }
  }
}

/**
 * materializeInclude({mainRoot, copyPath, manifest, execGit, fsImpl, platform, now})
 * -> {materialized, ms}. Carries the manifest's `copy` entries into the copy and
 * attaches its `link` entries by reference, in manifest order, and reports what it
 * did for every entry. Idempotent: run it again on the same copy and only genuinely
 * newer files move. Fail-open at the ENTRY level — one bad path becomes a
 * `{mode:'skipped', reason:'error: …'}` record and the rest still happens; nothing
 * throws out of here, because a provisioning answer is worth more than an exception.
 * @param {{mainRoot:string, copyPath:string, manifest?:object, execGit?:Function,
 *          fsImpl?:object, platform?:string, now?:Function}} opts
 * @returns {{materialized:object[], ms:number}}
 */
export function materializeInclude(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const t0 = now()
  const materialized = []
  try {
    const fs = opts.fsImpl ?? nodeFs
    const platform = opts.platform ?? process.platform
    const mainRoot = opts.mainRoot
    const copyPath = opts.copyPath
    const manifest = opts.manifest && typeof opts.manifest === 'object' ? opts.manifest : DEFAULT_WORKTREE_INCLUDE
    let trackedCache = null
    const trackedLazy = () => {
      if (!trackedCache) trackedCache = trackedSetOf({ mainRoot, execGit: opts.execGit })
      return trackedCache
    }
    const ctx = { fs, mainRoot, copyPath, platform, trackedLazy }

    for (const entry of Array.isArray(manifest.copy) ? manifest.copy : []) {
      try {
        materialized.push(materializeCopyEntry(entry, ctx))
      } catch (err) {
        materialized.push({ path: entry, mode: 'skipped', reason: `error: ${err && err.message}` })
      }
    }
    for (const entry of Array.isArray(manifest.link) ? manifest.link : []) {
      try {
        // A link is admissible ONLY for a dependency directory (node_modules at any
        // depth) — those are read-only to an attempt. Anything else named under
        // `link` is a directory somebody REBUILDS, and a junction turns a build in
        // the copy into a write into the MAIN tree: the attempt's isolation is
        // pierced and a git rollback of the branch cannot bring the clobbered
        // output back. Such an entry is not refused — the decision is made FOR the
        // manifest: the directory travels as a copy, and the answer says so in
        // words (`requested: 'link'` + the reason), so nobody has to diff
        // behaviour against intent later.
        if (DEPENDENCY_LINK_RE.test(normalizeRel(entry).replace(/\/+$/, ''))) {
          materialized.push(materializeLinkEntry(entry, ctx))
        } else {
          const rec = materializeCopyEntry(entry, ctx)
          materialized.push({
            ...rec,
            requested: 'link',
            linkRefusedReason: 'writable: a linked copy would write through into the main tree',
          })
        }
      } catch (err) {
        materialized.push({ path: entry, mode: 'skipped', reason: `error: ${err && err.message}` })
      }
    }
  } catch (err) {
    materialized.push({ path: '', mode: 'skipped', reason: `error: ${err && err.message}` })
  }
  return { materialized, ms: Math.max(0, now() - t0) }
}

/**
 * resolveSiblingRepo({env, readConfig, readProfile, profilePath, cwd, relativeFallback})
 * -> {path, source}. Resolves the sibling product repo (`../sma`) from an ABSOLUTE
 * recorded path in a FIXED, deterministic order:
 *   1. env.SMA_PRODUCT_REPO      (source: 'env')
 *   2. a `.sma/` config value    (source: 'config')  — via the injected readConfig
 *   3. the profile's productRepo (source: 'profile') — via profile.mjs readProfile
 *   4. the relative `../sma`      (source: 'relative') resolved against `cwd`
 * Each present source wins over the next; a missing/corrupt config or profile (a
 * reader that throws or returns nothing usable) falls THROUGH to the next source and
 * ultimately to the relative fallback — it NEVER throws. Read-only: never writes, never
 * modifies the profile.
 * @param {{env?:Object, readConfig?:Function, readProfile?:Function, profilePath?:string,
 *          cwd?:string, relativeFallback?:string}} [opts]
 * @returns {{path:string, source:('env'|'config'|'profile'|'relative')}}
 */
export function resolveSiblingRepo(opts = {}) {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const relativeFallback = opts.relativeFallback ?? '../sma'

  // 1. env — the explicit override always wins.
  const envVal = env && typeof env.SMA_PRODUCT_REPO === 'string' ? env.SMA_PRODUCT_REPO.trim() : ''
  if (envVal) return { path: envVal, source: 'env' }

  // 2. `.sma/` config value (tolerant — a throwing/absent reader falls through).
  try {
    if (typeof opts.readConfig === 'function') {
      const cfg = opts.readConfig()
      const v = cfg && typeof cfg.productRepo === 'string' ? cfg.productRepo.trim() : ''
      if (v) return { path: v, source: 'config' }
    }
  } catch {
    /* fall through to the profile */
  }

  // 3. the /sma-start profile's recorded absolute path (read-only via readProfile).
  try {
    if (typeof opts.readProfile === 'function') {
      const res = opts.readProfile({ profilePath: opts.profilePath })
      const profile = res && res.profile && typeof res.profile === 'object' ? res.profile : {}
      const v = typeof profile.productRepo === 'string' ? profile.productRepo.trim() : ''
      if (v) return { path: v, source: 'profile' }
    }
  } catch {
    /* fall through to the relative fallback */
  }

  // 4. relative `../sma` — the primary-checkout fallback, resolved against cwd.
  return { path: resolvePath(cwd, relativeFallback), source: 'relative' }
}
