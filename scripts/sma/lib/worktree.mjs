/**
 * worktree.mjs — per-TERMINAL git worktree isolation (9.3-14, D-9.3-24a/b, BL-156a).
 *
 * WHY THIS EXISTS
 * The founder runs MULTIPLE parallel Claude Code sessions against ONE checkout
 * that auto-deploys `main`. A parallel terminal's half-built work rides another
 * terminal's push (the recurring red-`main` failure). Per-terminal worktrees make
 * «your push carried my half-built work» PHYSICALLY impossible: each session gets
 * its own working directory + branch (`git worktree add <path> -b <branch>`), so two
 * sessions can never overwrite each other's files. Integration back to main is
 * SERIALIZED through 9.3-15's `sma merge` (local only); push stays founder-ordered
 * via /sma-ship. This module NEVER runs `git push` or `git merge`.
 *
 * THE MODEL IS PER-TERMINAL, NOT PER-PHASE OR EXECUTOR-ONLY (D-9.3-24a)
 * Three sessions sit on ONE phase today and the pain is human-driven parallel
 * sessions — so one worktree per TERMINAL is the model. Per-phase (too coarse — two
 * sessions on one phase still collide) and executor-only (misses the human-parallel
 * case entirely) are REJECTED.
 *
 * `.sma/` COORDINATION IS ALREADY WORKTREE-TRANSPARENT — NOT RE-PLUMBED (D-9.3-02)
 * registry.smaRoot() resolves `.sma/` to the MAIN checkout via
 * `git rev-parse --git-common-dir`, so every worktree session ALREADY registers in
 * the shared checkout's `.sma/` — the fingerprint, claims, sessions, and journal
 * «just work» across worktrees for free. Plan 14 provisions WORKING-TREE directories
 * ONLY; it imports/relies on that resolution and never re-implements coordination.
 *
 * THE SIBLING PRODUCT REPO RESOLVES FROM AN ABSOLUTE PATH (D-9.3-24b, closes BL-156)
 * Scripts operating on `../sma/scripts/sma/**` from INSIDE a worktree cannot trust a
 * relative `../sma` (it may not point at the same place as the main checkout's). So
 * resolveSiblingRepo reads a recorded ABSOLUTE product-repo path in a FIXED order:
 *   env SMA_PRODUCT_REPO  →  a `.sma/` config value  →  the /sma-start profile's
 *   recorded path (via profile.mjs readProfile)  →  the relative `../sma` fallback.
 * Every miss degrades to the next source; the relative fallback stays for the primary
 * checkout. It reads profile.mjs read-only — it NEVER modifies the profile.
 *
 * THE TWO WINDOWS HAZARDS ARE STRUCTURALLY GUARDED
 *   - feedback_worktree_base_windows_bug (fired 3/4 in P17.2, 3/3 on 2026-07-03): a
 *     Windows worktree can branch from a commit OLDER than HEAD. provisionWorktree
 *     CAPTURES EXPECTED_BASE = `git rev-parse HEAD` at creation, VERIFIES the new
 *     worktree's base against it, and prefers `git reset --hard $EXPECTED_BASE`
 *     (never --soft) on a mismatch — never trusts creation.
 *   - feedback_worktree_shell_teleport: a teleported shell CWD runs git on the wrong
 *     branch. EVERY git call passes an EXPLICIT cwd via the injected execGit — NEVER a
 *     bare `cd <dir> && git ...` shell string. This is also what makes the unit tests
 *     mockable: they pass a recording double and never spawn a real `git worktree`.
 *
 * FAIL-OPEN (substrate law C9): every public entrypoint is wrapped so a provisioning
 * error degrades to an honest {ok:false, fellBackToPrimary:true, message} + the primary
 * checkout, never a wedged session and never a throw that escapes to the caller.
 *
 * BRIDGE POSTURE (D-9.2-05, applied via D-9.3-24): worktree-per-terminal multiplayer
 * is vendor-absorbable (OpenAI acquired Multi in 2024) — a demolition clause with a
 * self-removal disposition, never headlined as a moat.
 *
 * DI CONVENTION (mirrors slots.mjs / registry.mjs): every git-touching function takes
 * an injectable `execGit(args, {cwd})` runner. The default real runner uses
 * execFileSync with an args ARRAY (no shell interpolation, no `cd`); tests pass a
 * recording double. Node built-ins only; zero npm deps.
 */

import { execFileSync } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'

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
    return { ok: true, path, branch, expectedBase, baseFixed, actualBase: actual }
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
    return { ok: true, reused: true, path: existing.path, branch: existing.branch, head: existing.head }
  }
  return { ...provisionWorktree({ branch, path, execGit, cwd }), reused: false }
}

/**
 * removeWorktree({path, execGit, cwd, force}) — `git worktree remove <path>` with an
 * EXPLICIT cwd. `--force` is added ONLY when `force:true` (git itself refuses a dirty
 * tree without it — that guard is preserved by not adding the flag by default).
 * Fail-open -> {ok:false, message}.
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

/**
 * resolveSiblingRepo({env, readConfig, readProfile, profilePath, cwd, relativeFallback})
 * -> {path, source}. Resolves the sibling product repo (`../sma`) from an ABSOLUTE
 * recorded path in a FIXED, deterministic order (D-9.3-24b):
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
