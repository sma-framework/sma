/**
 * terminal-attempt.mjs — the attempt trail of a PERSON'S WINDOW, written by the worker's
 * own writer into a directory of its own.
 *
 * ═══════════ WHY THIS IS A BRIDGE AND NOT A SECOND FORMAT ═══════════════════════════
 * A worker's try leaves a durable row: the commit its copy was cut from, the files it
 * changed against that commit, how it ended. A person's window left neither. The
 * coordination journal knows that a scope was claimed and later released, and nothing
 * about the point of return or what moved between those two moments — so «откатить
 * можно» was a guarantee a worker had and a person merely hoped for.
 *
 * The obvious repair — a trail of our own, shaped the way a terminal happens to need it —
 * is the wrong one, and it is wrong for a reason that is easy to state and easy to forget:
 * two formats agree on the day they are typed and stop agreeing the first time one of them
 * is extended. Then the day comes when a person and a worker did the same work and their
 * records cannot be compared, and nobody can say when they diverged. So there is ONE
 * writer here — `recordAttempt`, the queue's own — and ONE key list, `ALLOWED_ATTEMPT_KEYS`,
 * imported rather than copied. This module contributes no field, no shape and no second
 * ceiling: it contributes a DIRECTORY, a task id and the moment the base is captured.
 *
 * CROSSING FROM THE COMMAND LAYER INTO THE DAEMON'S — the precedent, named out loud. This
 * is not a new seam: the tool gate, the parity receipts and the recorded baseline already
 * import from `daemon/src`, so the layer is crossed in three places before this one. The
 * daemon's own door table is not touched by any of it — nothing here opens, renames or
 * removes a route, and no process is started.
 *
 * ═══════════ THE DIRECTORY IS OUR OWN, DELIBERATELY ═════════════════════════════════
 * `.sma/attempts/` — NOT the queue's ledger directory. A window's rows landing among the
 * queue's task rows would appear inside every existing reader of that directory: the
 * liveness sweep, the roster's attempt cards, the story-point report. Those readers are
 * correct about the tasks they were written for and would be silently wrong about a row
 * that never belonged to a task. Same format, same writer, different drawer.
 *
 * ═══════════ WHAT THE ROW SAYS, USING ONLY NAMES THE LIST ALREADY HAS ═══════════════
 * The opening row (claim): `base`, `branch`, `worktreePath`, `startedAt` — the point of
 * return, captured at the moment the scope was taken rather than derived afterwards, when
 * the answer is no longer obtainable.
 *
 * The closing row (release): `files`, `deletions` and their two overflow counters — the
 * worker's own list, computed by the worker's own reader — plus the verdict of the turn
 * gate, which rides `outcome`/`failureReason`:
 *
 *   • every changed path inside the claimed area → `outcome: 'completed'`;
 *   • a path outside it → `outcome: 'failed'` and `failureReason` NAMING the paths;
 *   • nothing measurable (no base, no git, no declared area) → NEITHER KEY IS WRITTEN.
 *
 * That third case is absence, not emptiness, and it is the same law the row's own module
 * states for its lists: a blank that says nothing is a record that lies quietly. A verdict
 * of «чисто» from a check that never ran is exactly the claim nobody may be able to read
 * off this file.
 *
 * WHY «FAILED» AND NOT A SOFTER WORD for the out-of-area case. The verdict is about the
 * CLAIM, not about the person: in a shared checkout the claimed area is what other windows
 * are told to stay off, so work that landed outside it was not covered by the protection
 * everyone was relying on. Saying so on the row is the whole reason the row exists; the
 * `failureReason` carries the names, so the reader never has to take the word alone.
 *
 * The claim's DESCRIPTION is not written. The key list has no home for it and nothing here
 * invents one — and it does not need one: the task id IS the description, transliterated by
 * the one transliteration this tree has, so the file name stays readable in any script.
 *
 * ═══════════ FAIL-OPEN, WITHOUT EXCEPTION ══════════════════════════════════════════
 * Every export swallows its own failure and answers with a blank. A trail is a record OF
 * work, never a condition FOR it: no claim, no release and no turn may ever be lost because
 * a ledger could not be written, a git refused to answer or a directory could not be made.
 * That is the posture of the whole hook chain around it, and this module inherits it whole.
 *
 * DEPENDENCY-INJECTED THROUGHOUT (`execGit`, `ledgerDir`, `env`, `cwd`) so the suite runs
 * against a throwaway repository and never touches a live registry or a live tree.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { recordAttempt, readAttempts } from '../../../daemon/src/queue/attempt-ledger.mjs'
import { compileGlob, normalizePath, relativizePath } from './collision.mjs'

/** The provider word on a window's row — what wrote it, in the field the worker uses. */
export const TERMINAL_PROVIDER = 'terminal'

/** The three verdict words the turn gate speaks. `null` is the fourth state: not measured. */
export const TURN_VERDICT_INSIDE = 'в области'
export const TURN_VERDICT_OUTSIDE = 'вне области'

/**
 * Default real git runner: `execFileSync` with an args ARRAY — no shell string and no
 * interpolation, the same posture every read-only git caller in this tree uses.
 */
export function defaultExecGit(args, opts = {}) {
  return String(execFileSync('git', args, { cwd: opts.cwd || process.cwd(), encoding: 'utf8' }) ?? '')
}

/**
 * terminalAttemptsDir({env}) — where a window's rows live when the caller names no
 * directory: `<project root>/.sma/attempts`. The project root comes from the anchor the
 * agent sets for hook processes, because a hook inherits the session's working directory
 * rather than starting at the project root — the fallback `.` is exactly what an unanchored
 * command resolved to before, so this is never worse than what it replaces.
 *
 * A caller that HAS the resolved root (the command line does) passes it instead; this is
 * the answer for the one that does not.
 */
export function terminalAttemptsDir({ env = process.env } = {}) {
  const anchor = (env && typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.trim()) || '.'
  return join(anchor, '.sma', 'attempts')
}

/** The ledger dir a call should use: the injected one, else the anchored default. */
function ledgerDirOf(o) {
  const given = o && typeof o.ledgerDir === 'string' && o.ledgerDir.trim()
  return given || terminalAttemptsDir({ env: (o && o.env) || process.env })
}

/** A one-line git read that never throws — a blank answer is an answer. */
function gitLine(execGit, args, cwd) {
  try {
    return String(execGit(args, { cwd }) ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * startTerminalAttempt({slug, description, identity, ledgerDir, execGit, env, cwd})
 * → the appended row, or `null` if nothing could be written.
 *
 * The world is captured HERE, at the moment the scope is taken, and not later: the commit
 * a window started from stops being derivable the moment it makes its first commit, and a
 * base reconstructed afterwards is a guess wearing the clothes of a record.
 *
 * The attempt NUMBER continues the file rather than restarting it — claiming the same scope
 * a second time is a second try at it, exactly as it is for a worker, and the ledger is the
 * one place where that count survives a restart.
 */
export function startTerminalAttempt(o = {}) {
  try {
    const slug = o.slug && String(o.slug).trim()
    if (!slug) return null
    const execGit = o.execGit || defaultExecGit
    const cwd = o.cwd || process.cwd()
    const dir = ledgerDirOf(o)

    const base = gitLine(execGit, ['rev-parse', 'HEAD'], cwd)
    const branch = gitLine(execGit, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    const worktreePath = gitLine(execGit, ['rev-parse', '--show-toplevel'], cwd) || cwd

    const identity = o.identity || {}
    return recordAttempt(dir, {
      taskId: slug,
      attempt: nextAttemptNumber(dir, slug),
      provider: TERMINAL_PROVIDER,
      ...(identity.holderIdentity ? { workerId: String(identity.holderIdentity) } : {}),
      ...(identity.terminalId ? { sessionId: String(identity.terminalId) } : {}),
      startedAt: new Date().toISOString(),
      // Absent, not empty, when git refused: an empty base reads as «база известна и пуста».
      ...(base ? { base } : {}),
      ...(branch ? { branch } : {}),
      ...(worktreePath ? { worktreePath } : {}),
    })
  } catch {
    return null // a trail is a record OF work, never a condition FOR it
  }
}

/** The next try number for a slug: one past the highest the file already carries. */
function nextAttemptNumber(dir, slug) {
  try {
    const rows = readAttempts(dir, slug)
    if (!rows.length) return 1
    // A row that closes an OPEN try continues its number; a fresh claim starts a new one.
    const open = rows.filter((r) => r && r.startedAt && !r.endedAt)
    const highest = rows.reduce((m, r) => (Number.isFinite(r && r.attempt) ? Math.max(m, r.attempt) : m), 0)
    return open.length ? highest : highest + 1
  } catch {
    return 1
  }
}

/**
 * readAttemptBase({slug, ledgerDir, env}) → `{base, branch, worktreePath, attempt}` of the
 * LAST row that carries a base, or `null`.
 *
 * The reader is the ledger's own (`readAttempts`) — a corrupt line is skipped there, a
 * missing file answers with nothing, and this module writes no second parser of a format it
 * does not own.
 */
export function readAttemptBase(o = {}) {
  try {
    const slug = o.slug && String(o.slug).trim()
    if (!slug) return null
    const rows = readAttempts(ledgerDirOf(o), slug)
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r && typeof r.base === 'string' && r.base) {
        return { base: r.base, branch: r.branch ?? null, worktreePath: r.worktreePath ?? null, attempt: r.attempt ?? 1 }
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * turnDiffVerdict({slug, globs, ledgerDir, execGit, cwd, env})
 * → `{base, files, deletions, filesOverflow, deletionsOverflow, outside, verdict, reason}`
 *
 * CHEAP BY CONSTRUCTION, because it runs at every turn boundary. It asks git to compare two
 * trees and it compares the answer with the claimed globs. That is all it does, and the two
 * read verbs it issues — `rev-parse` and `diff` — are the whole of its appetite.
 *
 * IT NEVER RUNS A COMMAND THAT ARRIVED AS DATA. The full re-check that re-executes the
 * commands written into receipts stays where it belongs: in the acceptance ritual and in the
 * verb a person types on purpose. On a per-turn hook it would mean running other people's
 * strings on a schedule instead of by a human decision, and paying a test suite's price
 * every turn to do it. This tree already refused to hang even the CHEAP release of claims on
 * the turn boundary; that judgement is inherited here rather than re-litigated.
 *
 * The changed-file reader is the WORKER'S, imported at the moment it is needed rather than
 * at load: a window with nothing claimed never pays for it, and there is still exactly one
 * implementation of that parse in the tree.
 *
 * @returns {Promise<object>} never throws; `verdict: null` means «not measured»
 */
export async function turnDiffVerdict(o = {}) {
  const blank = (reason) => ({
    base: null,
    files: [],
    deletions: [],
    filesOverflow: 0,
    deletionsOverflow: 0,
    outside: [],
    verdict: null,
    answered: false,
    reason,
  })
  try {
    const slug = o.slug && String(o.slug).trim()
    if (!slug) return blank('претензия не названа')
    const found = readAttemptBase({ slug, ledgerDir: o.ledgerDir, env: o.env })
    if (!found || !found.base) return blank('базового коммита нет — прогона диффа не было')

    const execGit = o.execGit || defaultExecGit
    const cwd = o.cwd || found.worktreePath || process.cwd()
    const { changedFilesOnBranch } = await import('../../../daemon/src/loop.mjs')
    const changed = changedFilesOnBranch({ execGit: (args, opts) => execGit(args, opts) }, found.base, 'HEAD', cwd)
    if (!changed || !changed.answered) return { ...blank(changed?.reason || 'git не ответил'), base: found.base }

    const globs = Array.isArray(o.globs) ? o.globs.filter((g) => typeof g === 'string' && g) : []
    const matchers = []
    for (const g of globs) {
      try {
        matchers.push(compileGlob(g))
      } catch {
        /* a malformed glob is skipped, never thrown — fail-open, as everywhere on this path */
      }
    }

    const rootNorm = normalizePath(found.worktreePath || cwd).replace(/\/+$/, '') + '/'
    const outside = []
    for (const f of changed.files) {
      const p = relativizePath(normalizePath(f && f.path ? f.path : ''), rootNorm)
      if (!p) continue
      if (!matchers.some((m) => m.test(p))) outside.push(p)
    }

    // No declared area means there is nothing to judge AGAINST — and a verdict invented out
    // of an absent declaration is the kind of clean answer that costs somebody a rollback.
    const verdict = !matchers.length
      ? null
      : outside.length
        ? TURN_VERDICT_OUTSIDE
        : TURN_VERDICT_INSIDE

    return {
      base: found.base,
      files: changed.files,
      deletions: changed.deletions,
      filesOverflow: changed.filesOverflow,
      deletionsOverflow: changed.deletionsOverflow,
      outside: matchers.length ? outside : [],
      verdict,
      answered: true,
      reason: matchers.length ? changed.reason : 'область претензии не заявлена',
    }
  } catch {
    return blank('гейт хода не смог посчитать разницу')
  }
}

/**
 * completeTerminalAttempt({slug, verdict, identity, ledgerDir, execGit, cwd, env})
 * → the appended closing row, or `null`.
 *
 * `verdict` is the object `turnDiffVerdict` returned — passed in rather than recomputed, so
 * the line a person was shown and the line written to the ledger are the SAME measurement.
 * Two computations of «the same» diff a second apart are two different claims the day a
 * commit lands between them.
 *
 * The ceilings and the overflow counters come from the worker's reader untouched; this
 * module owns no second number.
 */
export function completeTerminalAttempt(o = {}) {
  try {
    const slug = o.slug && String(o.slug).trim()
    if (!slug) return null
    const dir = ledgerDirOf(o)
    const v = o.verdict || {}
    const found = readAttemptBase({ slug, ledgerDir: o.ledgerDir, env: o.env })
    const identity = o.identity || {}

    const measured = v.answered === true
    const outside = Array.isArray(v.outside) ? v.outside : []

    return recordAttempt(dir, {
      taskId: slug,
      attempt: found ? found.attempt : 1,
      provider: TERMINAL_PROVIDER,
      ...(identity.holderIdentity ? { workerId: String(identity.holderIdentity) } : {}),
      ...(identity.terminalId ? { sessionId: String(identity.terminalId) } : {}),
      endedAt: new Date().toISOString(),
      ...(found && found.base ? { base: found.base } : {}),
      ...(found && found.branch ? { branch: found.branch } : {}),
      ...(found && found.worktreePath ? { worktreePath: found.worktreePath } : {}),
      // Absent, not empty, when the diff could not be taken.
      ...(measured
        ? {
            files: v.files,
            deletions: v.deletions,
            ...(v.filesOverflow ? { filesOverflow: v.filesOverflow } : {}),
            ...(v.deletionsOverflow ? { deletionsOverflow: v.deletionsOverflow } : {}),
          }
        : {}),
      // The gate's verdict — and NO verdict at all when nothing was measured.
      ...(v.verdict === TURN_VERDICT_INSIDE ? { outcome: 'completed' } : {}),
      ...(v.verdict === TURN_VERDICT_OUTSIDE
        ? { outcome: 'failed', failureReason: `вне заявленной области: ${outside.join(', ')}` }
        : {}),
    })
  } catch {
    return null
  }
}

/**
 * turnDiffLine(verdict) — the ONE human line the trail speaks, shared by the turn hook and
 * the release verb so a person never sees two spellings of one measurement.
 */
export function turnDiffLine(v) {
  if (!v || !v.base) return 'SMA след: базы нет — прогона диффа не было'
  const short = String(v.base).slice(0, 7)
  const n = Array.isArray(v.files) ? v.files.length : 0
  const overflow = v.filesOverflow ? ` (+${v.filesOverflow} сверх потолка)` : ''
  if (v.verdict === TURN_VERDICT_OUTSIDE) {
    return `SMA след: база ${short}, файлов ${n}${overflow}; вне области: ${(v.outside || []).join(', ')}`
  }
  if (v.verdict === TURN_VERDICT_INSIDE) {
    return `SMA след: база ${short}, файлов ${n}${overflow}; в области`
  }
  return `SMA след: база ${short}, файлов ${n}${overflow}; ${v.reason || 'прогона диффа не было'}`
}
