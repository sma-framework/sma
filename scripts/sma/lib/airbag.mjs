/**
 * airbag.mjs — the git airbag: a cheap GATE that writes a recovery point in
 * MILLISECONDS before a destructive git command runs (49.2-05, D-49.2-08).
 *
 * ═══════════════════════════════ WHY A GATE, NOT A BUNDLE ═══════════════════════
 *
 * The snapshot is `git update-ref` + `git stash create` + a batched `hash-object`/
 * `mktree` — all object-store/ref writes, O(dirty size), single-digit-to-tens of ms.
 * It is EXPLICITLY NOT a `git bundle`: a 5-second archive inside the PreToolUse hook
 * timeout gives FALSE protection at exactly the catastrophe moment — a large tree is
 * precisely when the bundle times out and NO snapshot is taken, so the one firing
 * that most needed a recovery point gets none. The grill flagged the bundle as a
 * design trap, not an optimization (D-49.2-08). Task 1 test 7 asserts on the injected
 * runner spy that the archive verb ('bundle') is NEVER passed on any path.
 *
 * ═══════════════════════════════ REF LAYOUT ════════════════════════════════════
 *
 * One hierarchical namespace so a single `for-each-ref refs/sma/airbag/` enumerates
 * snapshot GROUPS by the <id> segment:
 *   refs/sma/airbag/<id>/head             HEAD at snapshot time (ALWAYS pinned)
 *   refs/sma/airbag/<id>/stash            `git stash create` commit — dirty TRACKED state
 *   refs/sma/airbag/<id>/untracked        a single-level tree of pinned untracked blobs
 *   refs/sma/airbag/<id>/branch-<name>    a doomed branch tip (branch-delete / rebase)
 *   refs/sma/airbag/<id>/remote           the remote-tracking ref (force-push destroys it)
 * These refs live ONLY in the local object store — they are outside default push
 * refspecs and are NEVER pushed (T-49.2-05-06). Receipts carry untracked path NAMES
 * only, never content. `sma airbag prune` unpins old groups so the objects GC.
 *
 * ═══════════════════════════════ POSTURE ═══════════════════════════════════════
 *
 * PROTECTION IS UNCONDITIONAL: the snapshot ALWAYS happens on every destructive
 * firing, regardless of posture. Only the DENY tier is posture-gated (fail-open law,
 * carried V1/V2 lock): dormant = WARN-only; armed via SMA_AIRBAG_DENY = soft-deny on
 * a dirty tree / live foreign claim until an evidence record (the gates.mjs one-shot
 * override token GATE-AIRBAG, journaled with who/why) is present. A snapshot FAILURE
 * degrades to WARN + an ok:false journal receipt — NEVER a deny, never a block, never
 * an exception. Hard-deny stays the security guard's alone.
 *
 * ═══════════════════════════════ BRIDGE (D-49.2-05) ════════════════════════════
 *
 * This is one of the three ICE bridge-features and carries the demolition clause:
 * nativeCheckpointProbe is the capability sensor (stand the stream down the day a
 * native pre-Bash-git snapshot mechanism ships), P49.2-05-C is the registered
 * self-removal prediction, and the airbag is NEVER headlined in README/positioning.
 *
 * SMA-3 escaped-verb discipline: every sensitive git verb literal is assembled via
 * `['verb'].join('')` so this source never carries the adjacent dangerous literal
 * (matching gates.mjs). Node built-ins only; the git runner is DEPENDENCY-INJECTED
 * (execFileSync-shaped) so unit tests never shell out; zero LLM, zero npm deps.
 */

import { statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { appendEvent, readJournal } from './journal.mjs'
import { consumeOverrideToken } from './gates.mjs'
import {
  AIRBAG_REF_PREFIX,
  AIRBAG_UNTRACKED_MAX_FILES,
  AIRBAG_UNTRACKED_MAX_BYTES,
  AIRBAG_KEEP,
  AIRBAG_MAX_AGE_MS,
} from './constants.mjs'

// ── SMA-3 escaped sensitive verbs (assembled, never adjacent to their context) ──
const GIT = ['git'].join('')
const RESET_VERB = ['reset'].join('')
const CLEAN_VERB = ['clean'].join('')
const CHECKOUT_VERB = ['checkout'].join('')
const RESTORE_VERB = ['restore'].join('')
const PUSH_VERB = ['push'].join('')
const BRANCH_VERB = ['branch'].join('')
const REBASE_VERB = ['rebase'].join('')
const STASH_VERB = ['stash'].join('')

/** truthy env flag: set and not "0"/"false"/"". Mirrors gates.mjs. */
function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return !!s && s !== '0' && s !== 'false'
}

// ── the destructive-command matcher ─────────────────────────────────────────────

// A `git <verb>` occurrence anywhere in the (possibly &&-chained) command string.
const reGit = new RegExp('\\b' + GIT + '\\s+')
const reReset = new RegExp('\\b' + GIT + '\\s+' + RESET_VERB + '\\b([^&|;]*)')
const reClean = new RegExp('\\b' + GIT + '\\s+' + CLEAN_VERB + '\\b([^&|;]*)')
const reCheckoutPaths = new RegExp('\\b' + GIT + '\\s+' + CHECKOUT_VERB + '\\s+--(\\s|$)')
const reRestore = new RegExp('\\b' + GIT + '\\s+' + RESTORE_VERB + '\\b([^&|;]*)')
const rePush = new RegExp('\\b' + GIT + '\\s+' + PUSH_VERB + '\\b([^&|;]*)')
const reBranchDelete = new RegExp('\\b' + GIT + '\\s+' + BRANCH_VERB + '\\s+(?:-D|--delete\\s+--force|--delete|-D\\s+-f|-f\\s+-D)\\s+(\\S+)')
const reRebase = new RegExp('\\b' + GIT + '\\s+' + REBASE_VERB + '\\b([^&|;]*)')

/**
 * matchDestructive(command) -> {cmdClass, branchName?, ignoredInBlast?} | null.
 * A PURE matcher over the Bash tool command string. The command is ONLY matched —
 * no fragment of it EVER reaches our own git argv (T-49.2-05-01). Returns the first
 * (highest-severity) destructive class, or null for a safe command.
 *
 * Classes: 'reset-hard' | 'clean' | 'force-push' | 'branch-delete' |
 *          'checkout-paths' | 'restore' | 'rebase'.
 * @param {string} command
 * @returns {{cmdClass:string, branchName?:string, ignoredInBlast?:boolean}|null}
 */
export function matchDestructive(command) {
  if (typeof command !== 'string' || !command) return null
  if (!reGit.test(command)) return null // non-git destruction is the security guard's surface

  // force-push: a push carrying a force flag (plain push is safe → null).
  const push = rePush.exec(command)
  if (push) {
    const rest = push[1] || ''
    if (/(^|\s)(--force\b|--force-with-lease\b|-f\b)/.test(rest)) return { cmdClass: 'force-push' }
  }

  // reset --hard (a bare reset / --soft / --mixed is not blast-destructive → null).
  const reset = reReset.exec(command)
  if (reset && /(^|\s)--hard\b/.test(reset[1] || '')) return { cmdClass: 'reset-hard' }

  // clean with a force flag; -x additionally blasts IGNORED files (ignoredInBlast).
  const clean = reClean.exec(command)
  if (clean) {
    const rest = clean[1] || ''
    // -f may appear bundled (-fd, -ffd, -fdx) or standalone.
    if (/(^|\s)-{1,2}[a-z]*f/i.test(rest) || /--force\b/.test(rest)) {
      const ignoredInBlast = /(^|\s)-{1,2}[a-z]*x/i.test(rest)
      return { cmdClass: 'clean', ignoredInBlast }
    }
  }

  // branch -D <name> (capture the doomed branch name).
  const bd = reBranchDelete.exec(command)
  if (bd) return { cmdClass: 'branch-delete', branchName: bd[1] }

  // checkout -- <paths> (a `git checkout <branch>` switch is not matched here).
  if (reCheckoutPaths.test(command)) return { cmdClass: 'checkout-paths' }

  // restore <p> — but a STAGED-ONLY restore (--staged without --worktree/-W) leaves
  // the worktree untouched → null; a worktree restore (default, or --worktree/-W) blasts.
  const restore = reRestore.exec(command)
  if (restore) {
    const rest = restore[1] || ''
    const staged = /(^|\s)--staged\b/.test(rest)
    const worktree = /(^|\s)(--worktree\b|-W\b)/.test(rest)
    if (!(staged && !worktree)) return { cmdClass: 'restore' }
  }

  // rebase <base> — but the mid-rebase plumbing (--continue/--abort/--skip/--quit/
  // --edit-todo) is NOT destructive (--abort IS the recovery) → null.
  const rebase = reRebase.exec(command)
  if (rebase) {
    const rest = rebase[1] || ''
    if (!/(^|\s)--(continue|abort|skip|quit|edit-todo)\b/.test(rest)) return { cmdClass: 'rebase' }
  }

  return null
}

// ── snapshot id + porcelain parsing ─────────────────────────────────────────────

/** Compact UTC stamp `YYYYMMDDTHHMMSSmmmZ` — lexically sorts chronologically (refname sort). */
function compactStamp(ms) {
  const iso = new Date(ms).toISOString() // 2026-07-08T14:30:25.123Z
  return iso.replace(/[-:]/g, '').replace('.', '')
}

/** 4 hex chars of intra-ms uniqueness. */
function rand4() {
  return Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')
}

/**
 * parsePorcelain(text) -> {dirtyTracked:boolean, untracked:string[]}. ONE
 * `status --porcelain` call yields both: a `??` line is untracked; any other
 * non-blank status line is a tracked modification (staged or unstaged).
 */
function parsePorcelain(text) {
  const untracked = []
  let dirtyTracked = false
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw) continue
    if (raw.startsWith('??')) {
      untracked.push(raw.slice(3).trim())
    } else if (raw.trim()) {
      dirtyTracked = true
    }
  }
  return { dirtyTracked, untracked }
}

/** Sanitize a branch name into a single ref segment (slashes → dashes). */
function refSafe(name) {
  return String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed'
}

// ── the ms-level snapshot engine ────────────────────────────────────────────────

/**
 * takeSnapshot({cmdClass, meta}, {runGit, now, statSize, repoRoot}) -> receipt.
 *
 * runGit(argv[], {input?}) is execFileSync-shaped over `git` (the runner prepends
 * `git`; argv is a FIXED array — NO fragment of the user command ever enters it).
 * The working tree and the index are NEVER touched — only object-store / ref writes
 * (update-ref, stash create, hash-object -w, mktree). NEVER invokes the archive verb.
 * Fully fail-open: any runner throw yields {ok:false, error} and NEVER throws (test 6).
 *
 * @param {{cmdClass:string, meta?:object}} evt
 * @param {{runGit:Function, now?:Function, statSize?:Function, repoRoot?:string}} deps
 * @returns {object} receipt
 */
export function takeSnapshot(evt = {}, deps = {}) {
  const runGit = deps.runGit
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const repoRoot = deps.repoRoot || '.'
  const statSize =
    typeof deps.statSize === 'function'
      ? deps.statSize
      : (p) => {
          try {
            return statSync(join(repoRoot, p)).size
          } catch {
            return 0
          }
        }
  const cmdClass = evt.cmdClass
  const meta = evt.meta || {}
  const started = now()
  const snapshotId = `${compactStamp(started)}-${rand4()}`
  const base = `${AIRBAG_REF_PREFIX}${snapshotId}`
  const refs = {}
  const receipt = {
    ok: false,
    snapshotId,
    cmdClass,
    dirty: false,
    untrackedCount: 0,
    refs,
    indexPathMap: {},
    elapsedMs: 0,
  }

  try {
    if (typeof runGit !== 'function') throw new Error('runGit required')

    // (1) ALWAYS pin HEAD first — the one unconditional recovery point.
    runGit(['update-ref', `${base}/head`, 'HEAD'])
    refs.head = `${base}/head`

    // (2) ONE porcelain call → both tracked-dirty and the untracked list.
    const porcelain = String(runGit(['status', '--porcelain']) ?? '')
    const { dirtyTracked, untracked } = parsePorcelain(porcelain)
    receipt.dirty = dirtyTracked

    // (3) dirty TRACKED state → a pinned stash-create commit (apply-able by sha).
    if (dirtyTracked) {
      const stashSha = String(runGit([STASH_VERB, 'create']) ?? '').trim()
      if (stashSha) {
        runGit(['update-ref', `${base}/stash`, stashSha])
        refs.stash = `${base}/stash`
      }
    }

    // (4) untracked files → ONE batched hash-object, a single-level mktree, one pin.
    //     Caps (200 files / 10 MB) guard against a cap-explosion; ignored files
    //     (a `clean -x` blast) are NEVER enumerated (ignoredNotCaptured instead).
    if (meta && meta.ignoredInBlast) receipt.ignoredNotCaptured = true
    if (untracked.length) {
      const capped = []
      let bytes = 0
      let truncated = false
      for (const p of untracked) {
        if (capped.length >= AIRBAG_UNTRACKED_MAX_FILES) {
          truncated = true
          break
        }
        const sz = statSize(p) || 0
        if (capped.length > 0 && bytes + sz > AIRBAG_UNTRACKED_MAX_BYTES) {
          truncated = true
          break
        }
        bytes += sz
        capped.push(p)
      }
      if (truncated) receipt.untrackedTruncated = true
      receipt.untrackedRemaining = untracked.slice(capped.length) // NAMES only

      if (capped.length) {
        const blobOut = String(runGit(['hash-object', '-w', '--stdin-paths'], { input: capped.join('\n') + '\n' }) ?? '')
        const shas = blobOut.split('\n').map((s) => s.trim()).filter(Boolean)
        // build a single-level tree; entry NAME = zero-based index (path chars never
        // enter a tree name — the receipt's index→path map is the restore key).
        const mkLines = []
        const indexPathMap = {}
        for (let i = 0; i < shas.length && i < capped.length; i++) {
          mkLines.push(`100644 blob ${shas[i]}\t${i}`)
          indexPathMap[i] = capped[i]
        }
        if (mkLines.length) {
          const tree = String(runGit(['mktree'], { input: mkLines.join('\n') + '\n' }) ?? '').trim()
          if (tree) {
            runGit(['update-ref', `${base}/untracked`, tree])
            refs.untracked = `${base}/untracked`
            receipt.indexPathMap = indexPathMap
          }
        }
      }
      receipt.untrackedCount = capped.length
    }

    // (5) per-class extra pins — each guarded so a missing ref never fails the snapshot.
    if (cmdClass === 'branch-delete' && meta.branchName) {
      try {
        const seg = refSafe(meta.branchName)
        runGit(['update-ref', `${base}/branch-${seg}`, `refs/heads/${meta.branchName}`])
        refs.branch = `${base}/branch-${seg}`
      } catch {
        /* branch already gone / unresolvable — skip */
      }
    }
    if (cmdClass === 'force-push') {
      try {
        const branch = String(runGit(['symbolic-ref', '--short', 'HEAD']) ?? '').trim()
        if (branch) {
          runGit(['update-ref', `${base}/remote`, `refs/remotes/origin/${branch}`])
          refs.remote = `${base}/remote`
        }
      } catch {
        /* no remote-tracking ref — skip */
      }
    }
    if (cmdClass === 'rebase') {
      try {
        const branch = String(runGit(['symbolic-ref', '--short', 'HEAD']) ?? '').trim()
        if (branch) {
          const seg = refSafe(branch)
          runGit(['update-ref', `${base}/branch-${seg}`, `refs/heads/${branch}`])
          refs.branch = `${base}/branch-${seg}`
        }
      } catch {
        /* detached HEAD — head pin already covers it */
      }
    }

    receipt.ok = true
  } catch (e) {
    receipt.ok = false
    receipt.error = e && e.message ? e.message : String(e)
  }
  receipt.elapsedMs = Math.max(0, now() - started)
  return receipt
}

// ── the capability probe (demolition-clause sensor, D-49.2-05a / P49.2-05-C) ─────

/**
 * nativeCheckpointProbe({env}) -> {native, probeVersion}. v1: today NO runtime
 * mechanism snapshots command side effects before a Bash git command (Claude Code
 * checkpoints cover file EDITS, not command side effects), so native is false unless
 * the versioned test seam SMA_NATIVE_CHECKPOINTS is truthy. When native, the airbag
 * stands down (D-49.2-05). This probe prints the P49.2-05-C scorer's numeric.
 * @param {{env?:object}} [opts]
 * @returns {{native:boolean, probeVersion:number}}
 */
export function nativeCheckpointProbe({ env = {} } = {}) {
  return { native: truthy(env.SMA_NATIVE_CHECKPOINTS), probeVersion: 1 }
}

// ── soft-deny condition helpers ─────────────────────────────────────────────────

/**
 * foreignClaimCondition(cmdClass, {sessions, selfTerminalId, slots, dirs}) -> boolean.
 * For 'force-push': a live FOREIGN push-claim (slots.checkPushClaim). For every other
 * (tree-wide) class: any OTHER live session in the registry holding a scope claim.
 * Fail-open: any error → false (a coordination bug never falsely soft-denies).
 */
function foreignClaimCondition(cmdClass, opts = {}) {
  try {
    if (cmdClass === 'force-push') {
      const slots = opts.slots
      if (!slots || typeof slots.checkPushClaim !== 'function') return false
      const pc = slots.checkPushClaim(opts.dirs || {})
      if (!pc || !pc.live) return false
      // a foreign push is in progress (our own push-claim would be self — the who
      // string is a display label; any live claim here is a coordination signal).
      return true
    }
    const sessions = Array.isArray(opts.sessions) ? opts.sessions : []
    const selfFile = opts.selfTerminalId ? `${opts.selfTerminalId}.json` : null
    for (const s of sessions) {
      if (!s || s._file === selfFile) continue
      const globs = s.scope && Array.isArray(s.scope.globs) ? s.scope.globs : []
      if (globs.length > 0) return true
    }
    return false
  } catch {
    return false
  }
}

// ── the in-process check (the `sma pre` contract + the standalone hook) ──────────

/**
 * checkAirbag(evt, opts) -> {warns:string[], deny?:{text}, receipt}. The gates.checkEvent-
 * shaped in-process contract for plan 02's `sma pre` AND the standalone airbag-check hook:
 *   Bash events only → matchDestructive → probe stand-down → snapshot (UNCONDITIONAL) →
 *   journal receipt (type 'airbag') → soft-deny CONDITIONS (dirty / foreign) → deny ONLY
 *   when SMA_AIRBAG_DENY is armed AND no evidence token exists (the gates.mjs GATE-AIRBAG
 *   one-shot override). On success the check is SILENT (receipt only); WARN lines appear
 *   only for a snapshot FAILURE, truncation, or the dormant-posture dirty/foreign condition.
 * Whole body fail-open — an airbag bug can NEVER wedge a session or falsely deny.
 *
 * @param {object} evt  the PreToolUse hook event ({tool_name, tool_input})
 * @param {{dirs?:object, runGit:Function, env?:object, seen?:object, now?:Function,
 *          sessions?:Array, selfTerminalId?:string, slots?:object, terminalId?:string,
 *          journalAppend?:Function, statSize?:Function, repoRoot?:string}} opts
 */
export function checkAirbag(evt = {}, opts = {}) {
  const out = { warns: [], receipt: null }
  try {
    if (!evt || evt.tool_name !== 'Bash') return out
    const command = evt.tool_input && typeof evt.tool_input.command === 'string' ? evt.tool_input.command : ''
    const m = matchDestructive(command)
    if (!m) return out

    const env = opts.env || {}
    const dirs = opts.dirs || {}
    const terminalId = opts.terminalId || 'unknown'
    const journalDir = dirs.journalDir
    const append = typeof opts.journalAppend === 'function' ? opts.journalAppend : appendEvent
    const seen = opts.seen && typeof opts.seen === 'object' ? opts.seen : { keys: {} }
    if (!seen.keys || typeof seen.keys !== 'object') seen.keys = {}

    // Probe stand-down (D-49.2-05a): a native mechanism → no snapshot, no warn, a
    // single journal note once per session (reflex seen-store key prefix 'airbag:').
    const probe = nativeCheckpointProbe({ env })
    if (probe.native) {
      const key = 'airbag:standdown'
      if (!seen.keys[key]) {
        seen.keys[key] = 1
        journalSafe(append, { type: 'airbag', actors: [terminalId], scope: '', detail: { standDown: true, probeVersion: probe.probeVersion } }, terminalId, journalDir)
      }
      return out
    }

    // Snapshot — UNCONDITIONAL (protection is not posture-gated).
    const receipt = takeSnapshot(
      { cmdClass: m.cmdClass, meta: m },
      { runGit: opts.runGit, now: opts.now, statSize: opts.statSize, repoRoot: opts.repoRoot },
    )
    out.receipt = receipt

    // Journal the receipt (type 'airbag') — the S2 instrument + coverage denominator.
    journalSafe(
      append,
      {
        type: 'airbag',
        actors: [terminalId],
        scope: command.slice(0, 200),
        detail: {
          snapshotId: receipt.snapshotId,
          cmdClass: receipt.cmdClass,
          refs: receipt.refs,
          dirty: receipt.dirty,
          untrackedCount: receipt.untrackedCount,
          untrackedTruncated: receipt.untrackedTruncated === true,
          ignoredNotCaptured: receipt.ignoredNotCaptured === true,
          elapsedMs: receipt.elapsedMs,
          ok: receipt.ok,
          headRef: !!(receipt.refs && receipt.refs.head),
          indexPathMap: receipt.indexPathMap,
        },
      },
      terminalId,
      journalDir,
    )

    // WARN lines: snapshot failure (degrade, NEVER deny) + truncation.
    if (!receipt.ok) {
      out.warns.push(
        'SMA-airbag: снимок НЕ создан перед разрушительной git-командой (' + m.cmdClass + '). ' +
          'Защита не сработала — проверьте состояние git вручную ПЕРЕД выполнением. Kill-switch: SMA_AIRBAG_DISABLE=1.',
      )
    } else if (receipt.untrackedTruncated) {
      out.warns.push(
        'SMA-airbag: снимок создан, но часть untracked-файлов не захвачена (превышен лимит ' +
          AIRBAG_UNTRACKED_MAX_FILES + ' файлов / ' + Math.round(AIRBAG_UNTRACKED_MAX_BYTES / (1024 * 1024)) +
          ' МБ). Имена не захваченных файлов записаны в квитанции; восстановление вернёт только захваченное.',
      )
    }

    // Soft-deny CONDITIONS — dirty tree or a live foreign claim.
    const conditions = []
    if (receipt.dirty) conditions.push('dirty')
    if (foreignClaimCondition(m.cmdClass, { sessions: opts.sessions, selfTerminalId: opts.selfTerminalId, slots: opts.slots, dirs })) {
      conditions.push('foreign')
    }

    if (conditions.length) {
      if (truthy(env.SMA_AIRBAG_DENY)) {
        // Armed: the evidence escape REUSES gates.mjs's one-shot override token
        // (GATE-AIRBAG). Present → consumed + journaled 'gate-override', allow;
        // absent → deny. NO new evidence machinery is built (D-49-09 provenance).
        const overridden = consumeOverrideToken('GATE-AIRBAG', { gatesDir: dirs.gatesDir, journalDir, terminalId })
        if (!overridden) {
          out.deny = { text: denyText(command, conditions) }
        }
      } else {
        // Dormant posture: WARN only (carried-forward fail-open law).
        out.warns.push(
          'SMA-airbag: разрушительная git-команда (' + m.cmdClass + ') при условии «' + conditions.join(', ') +
            '». Снимок создан (' + receipt.snapshotId + '); откат: pnpm sma undo. ' +
            'Мягкий deny включается только при SMA_AIRBAG_DENY=1.',
        )
      }
    }
  } catch {
    /* fail-open (C9) — an airbag bug can NEVER wedge a session or falsely deny */
  }
  return out
}

/** The soft-deny text: names the command, the condition, and the kill-switch. */
function denyText(command, conditions) {
  return (
    'SMA-airbag [GATE-AIRBAG] DENY: разрушительная git-команда заблокирована — «' +
    String(command).slice(0, 160) + '» при условии «' + conditions.join(', ') + '» ' +
    '(грязное дерево / чужая заявка). Снимок УЖЕ создан, откат: pnpm sma undo. ' +
    'Разовый override с провенансом: pnpm sma gates override GATE-AIRBAG --yes --reason "почему". ' +
    'Kill-switch: SMA_AIRBAG_DISABLE=1 (или снять арм: SMA_AIRBAG_DENY=0).'
  )
}

/** journal an event, swallowing any failure (a journal error never blocks the gate). */
function journalSafe(append, event, terminalId, journalDir) {
  if (!journalDir || !terminalId) return
  try {
    append(event, { terminalId, journalDir })
  } catch {
    /* fail-open */
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Task 2 — the restore leg: `sma undo` one-action recovery + list/prune. `for-each-ref`
// over refs/sma/airbag/ IS the snapshot index (git is the store; no pointer file).
// The restore step, UNLIKE the check path, MAY write the working tree — it is an
// explicit user action, never hook-triggered.
// ════════════════════════════════════════════════════════════════════════════

/**
 * listSnapshots({runGit}) -> [{id, refs, refnames}] newest-first. `for-each-ref
 * --sort=-refname refs/sma/airbag/` enumerates every pinned ref; entries are grouped
 * by the <id> segment. Fail-open → []. Read-only.
 */
export function listSnapshots({ runGit } = {}) {
  const groups = new Map()
  try {
    if (typeof runGit !== 'function') return []
    const text = String(runGit(['for-each-ref', '--sort=-refname', AIRBAG_REF_PREFIX]) ?? '')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const sha = line.slice(0, tab).trim().split(/\s+/)[0]
      const refname = line.slice(tab + 1).trim()
      if (!refname.startsWith(AIRBAG_REF_PREFIX)) continue
      const rest = refname.slice(AIRBAG_REF_PREFIX.length) // '<id>/<sub>'
      const slash = rest.indexOf('/')
      if (slash < 0) continue
      const id = rest.slice(0, slash)
      const sub = rest.slice(slash + 1)
      if (!groups.has(id)) groups.set(id, { id, refs: {}, refnames: [] })
      const g = groups.get(id)
      g.refnames.push(refname)
      if (sub === 'head') g.refs.head = refname
      else if (sub === 'stash') g.refs.stash = refname
      else if (sub === 'untracked') g.refs.untracked = refname
      else if (sub === 'remote') g.refs.remote = refname
      else if (sub.startsWith('branch-')) g.refs.branch = refname
      g.refs[`_sha_${sub}`] = sha
    }
  } catch {
    return []
  }
  // compact-stamp ids sort chronologically → desc == newest first.
  return [...groups.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** Parse the ms epoch from a snapshotId (`YYYYMMDDTHHMMSSmmmZ-rand4`), or NaN. */
function idToMs(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(String(id))
  if (!m) return NaN
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`)
}

/** Read the index→path map for a snapshot from the journal ('airbag' receipt), or null. */
function lookupIndexPathMap(id, { dirs = {}, readJournalFn } = {}) {
  try {
    const reader = typeof readJournalFn === 'function' ? readJournalFn : readJournal
    const r = reader({ journalDir: dirs.journalDir })
    const events = Array.isArray(r) ? r : (r && r.events) || []
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e && e.type === 'airbag' && e.detail && e.detail.snapshotId === id && e.detail.indexPathMap) {
        return e.detail.indexPathMap
      }
    }
  } catch {
    /* fail-open */
  }
  return null
}

/**
 * restoreSnapshot({snapshotId?, dryRun}, {runGit, dirs, repoRoot, ...}) -> result.
 * ONE action back from a catastrophe:
 *   (0) a FRESH self-snapshot FIRST — undo is itself destructive and gets its own airbag;
 *   (1) reset --hard <id>/head;
 *   (2) if <id>/stash, stash apply its sha (a stash-create commit applies directly);
 *   (3) if <id>/untracked, ls-tree → cat-file blob each → write to the receipt's
 *       index→path map paths (overwrite — this is a restore). If the journal map is
 *       missing (pruned/corrupt), restore head+stash anyway + WARN (fail-open degradation).
 * --dry-run prints the plan and performs ZERO writes (returns before the self-snapshot).
 * Every runGit call is a FIXED argv array. Never throws.
 *
 * @param {{snapshotId?:string, dryRun?:boolean}} args
 * @param {{runGit:Function, dirs?:object, repoRoot?:string, now?:Function,
 *          writeFile?:Function, journalAppend?:Function, terminalId?:string, readJournalFn?:Function}} deps
 */
export function restoreSnapshot(args = {}, deps = {}) {
  const { runGit, dirs = {}, repoRoot = '.', now, terminalId = 'unknown' } = deps
  const warns = []
  try {
    if (typeof runGit !== 'function') return { ok: false, error: 'runGit required', warns }
    const groups = listSnapshots({ runGit })
    if (!groups.length) return { ok: false, error: 'нет снимков airbag', warns }
    const target = args.snapshotId ? groups.find((g) => g.id === args.snapshotId) : groups[0]
    if (!target) return { ok: false, error: `снимок не найден: ${args.snapshotId}`, warns }

    const map = lookupIndexPathMap(target.id, { dirs, readJournalFn: deps.readJournalFn })
    const plan = {
      snapshotId: target.id,
      head: !!target.refs.head,
      stash: !!target.refs.stash,
      untracked: !!target.refs.untracked,
      untrackedMapKnown: !!map,
    }
    if (args.dryRun) return { ok: true, dryRun: true, plan, warns }

    // (0) fresh self-snapshot FIRST (undo protects itself).
    const pre = takeSnapshot({ cmdClass: 'undo', meta: {} }, { runGit, now, repoRoot })

    // (1) reset --hard <id>/head.
    if (!target.refs.head) return { ok: false, error: 'у снимка нет head-ref', preSnapshotId: pre.snapshotId, warns }
    runGit([RESET_VERB, '--hard', target.refs.head])

    // (2) re-apply dirty tracked state from the pinned stash-create commit.
    if (target.refs.stash) {
      try {
        const sha = String(runGit(['rev-parse', target.refs.stash]) ?? '').trim()
        if (sha) runGit([STASH_VERB, 'apply', sha])
      } catch {
        warns.push('stash apply не удался — грязное отслеживаемое состояние не восстановлено')
      }
    }

    // (3) restore untracked blobs to their recorded paths.
    let untrackedRestored = 0
    if (target.refs.untracked) {
      if (!map) {
        warns.push('карта untracked недоступна (журнал отсутствует/подрезан) — имена не восстановимы')
      } else {
        try {
          const tree = String(runGit(['ls-tree', target.refs.untracked]) ?? '')
          const write = typeof deps.writeFile === 'function' ? deps.writeFile : defaultWriteFile(repoRoot)
          for (const line of tree.split('\n')) {
            if (!line.trim()) continue
            const m = /^\S+\s+blob\s+(\S+)\t(.+)$/.exec(line)
            if (!m) continue
            const path = map[m[2]]
            if (!path) continue
            const buf = runGit(['cat-file', 'blob', m[1]], { buffer: true })
            write(path, buf)
            untrackedRestored += 1
          }
        } catch (e) {
          warns.push('восстановление untracked прервано: ' + (e && e.message ? e.message : String(e)))
        }
      }
    }

    // (4) journal the undo (type 'undo') with source + pre-undo snapshot ids.
    journalSafe(
      typeof deps.journalAppend === 'function' ? deps.journalAppend : appendEvent,
      { type: 'undo', actors: [terminalId], scope: target.id, detail: { source: target.id, preSnapshotId: pre.snapshotId, untrackedRestored, warns: warns.length } },
      terminalId,
      dirs.journalDir,
    )
    return { ok: true, snapshotId: target.id, preSnapshotId: pre.snapshotId, untrackedRestored, warns }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), warns }
  }
}

/** Default untracked writer: writes (Buffer|string) under repoRoot, mkdir -p first. */
function defaultWriteFile(repoRoot) {
  return (p, content) => {
    const abs = join(repoRoot, p)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/**
 * pruneSnapshots({keep, maxAgeMs}, {runGit, dirs, now, journalAppend, terminalId}) ->
 * {kept, removed}. Keeps the newest `keep` groups and drops any group older than
 * `maxAgeMs`; each dropped ref is unpinned via `update-ref -d` (pinned objects become
 * GC-eligible only after unpinning). Journals the prune. Fail-open per ref.
 */
export function pruneSnapshots(opts = {}, deps = {}) {
  const keepN = Number.isFinite(opts.keep) ? opts.keep : AIRBAG_KEEP
  const maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : AIRBAG_MAX_AGE_MS
  const { runGit, dirs = {}, terminalId = 'unknown' } = deps
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now()
  const removed = []
  try {
    const groups = listSnapshots({ runGit })
    groups.forEach((g, i) => {
      const ageMs = nowMs - idToMs(g.id)
      const tooOld = Number.isFinite(ageMs) && ageMs > maxAge
      if (i >= keepN || tooOld) {
        for (const ref of g.refnames) {
          try {
            runGit(['update-ref', '-d', ref])
          } catch {
            /* a missing ref is already gone — skip */
          }
        }
        removed.push(g.id)
      }
    })
    if (removed.length) {
      journalSafe(
        typeof deps.journalAppend === 'function' ? deps.journalAppend : appendEvent,
        { type: 'airbag', actors: [terminalId], scope: 'prune', detail: { prune: true, removed } },
        terminalId,
        dirs.journalDir,
      )
    }
    return { kept: groups.length - removed.length, removed }
  } catch {
    return { kept: 0, removed }
  }
}
