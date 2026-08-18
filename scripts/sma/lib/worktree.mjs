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
        materialized.push(materializeLinkEntry(entry, ctx))
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
