/**
 * project-sync.mjs — THE CONNECTED PROJECT: watched live, read read-only. The
 * «Рабочее место» screen consumes this and does not build it.
 *
 * ═══════════════════════ THE TRUTH STAYS IN THE FILES ════════════════════════════
 * This module inherits harness.mjs's law verbatim: the truth lives in the connected
 * project's own files and the daemon holds NO copy of its own. There is no cache here, no
 * memo, no note body kept between calls and no invalidation verb — because there is nothing
 * to invalidate. A read after an edit reflects the edit because it re-reads. The watcher's
 * only state is «what did the surface look like when I last said something», which is a
 * DIGEST of names, sizes and modification times — never content.
 *
 * ═══════════════════════ A HINT IS A DOORBELL (events.mjs) ═══════════════════════
 * A change emits the EXISTING `project.updated` frame, which carries a project id and
 * nothing else. The screen re-reads GET /api/state to learn what moved. No file name, no
 * path and no note text ever rides a frame, so a hostile filename cannot travel.
 *
 * ═══════════════════════ WHY A RECONCILE EXISTS AT ALL ═══════════════════════════
 * This runs on a researched assumption: node's native recursive watch is enough, and
 * the product ships no watcher dependency. The honest risk is that recursive watch behaves
 * differently per platform — rename versus change, coalescing, and network or virtualised
 * filesystems where events are dropped outright. A dropped event would leave the screen
 * silently stale, which is worse than a screen that never claimed to be live. So the design
 * does not rely on the assumption holding:
 *
 *   - bursts are DEBOUNCED into one hint (ten writes of a corpus rebuild are one doorbell);
 *   - a slow RECONCILE re-reads the surface digest regardless of whether an event arrived,
 *     and emits only when it actually moved — the same belt-and-suspenders idea as the
 *     queue's livenessSweep, applied to files. The worst case of a missed event is therefore
 *     a delay of one interval, never a permanent lie;
 *   - a watch that cannot be established, or that errors at runtime, DEGRADES to
 *     reconcile-only and reports that fact ONCE, so the screen can say «обновляется раз в
 *     минуту» instead of pretending to be live. A silent downgrade to nothing is the exact
 *     failure this whole arrangement exists to prevent.
 *
 * ═══════════════════════ SCOPED, NOT RECURSIVE OVER A REPO ═══════════════════════
 * A connected project is arbitrary content on disk. The watch is scoped to the project's
 * configuration directory and its memory corpus — never the whole tree — so a huge or
 * hostile repository cannot exhaust the daemon's handles. A watch failure
 * degrades once; it is never retried in a loop.
 *
 * Node built-ins only. The watch implementation, the one-shot debounce scheduler, the
 * repeating reconcile scheduler and the whole fs are injectable, because this module is the
 * daemon's first watcher and has no analog to copy — its testability comes entirely from
 * injection. Zero deps.
 */

import { createHash } from 'node:crypto'
import {
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
  watch as fsWatch,
} from 'node:fs'
import { join } from 'node:path'

import { parseNote } from '../../../scripts/sma/lib/frontmatter.mjs'
import { applyProposal, previewMigration } from '../../../scripts/sma/lib/migrate-v1-v2.mjs'
import { deriveMemory } from './state.mjs'

/**
 * The two directories a connected project is watched through, relative to its root. The
 * corpus is watched in its OWN right rather than left to recursion: on a platform where
 * recursive watch is unavailable, watching `.claude` alone would silently stop covering the
 * notes, which is the half of the tree this screen is about.
 */
const WATCH_SUBDIRS = Object.freeze(['.claude', join('.claude', 'memory')])

/** Where a project's corpus lives, by the product-wide convention. */
const MEMORY_SUBDIR = Object.freeze(['.claude', 'memory'])

/** Generated / registry artifacts of a corpus — structural files, not notes (state.mjs). */
const STRUCTURAL = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])

/**
 * A migration only ever addresses a PLAIN note file directly inside the corpus. The apply
 * path validates this before it reads anything, and `applyProposal` validates the draft's
 * own declared source again on the other side — the same fact checked at both ends of the
 * door, because this is the one path in this module that writes into a foreign project.
 */
const CORPUS_FILE_RE = /^[A-Za-z0-9._-]{1,64}\.md$/

/** How long a burst of filesystem events is collapsed into one hint. */
const DEBOUNCE_MS = 400

/**
 * How often the surface is re-read regardless of events. Slow on purpose: this is
 * insurance against a dropped event, not the transport. The screen's own poll is seconds.
 */
const RECONCILE_MS = 60000

/** memoryDirOf(projectDir) — the corpus directory of a connected project, or null. */
export function memoryDirOf(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return null
  return join(projectDir, ...MEMORY_SUBDIR)
}

/** The fs calls this module makes, defaulted to node:fs and injectable for tests. */
function fsSeam(fsImpl) {
  const io = fsImpl ?? {}
  return {
    readdirSync: io.readdirSync ?? fsReaddirSync,
    readFileSync: io.readFileSync ?? fsReadFileSync,
    statSync: io.statSync ?? fsStatSync,
    rmSync: io.rmSync ?? fsRmSync,
  }
}

/** A note file is anything that is not a generated index or the tag registry. */
function isNoteFile(file) {
  return file.endsWith('.md') && !STRUCTURAL.has(file) && !/^INDEX-.+\.md$/.test(file)
}

/**
 * surfaceDigest(io, projectDir) — a CHEAP fingerprint of the watched surface: every entry's
 * name, size and modification time, and NEVER its contents. Reading bodies on a timer would
 * turn insurance into a copy of the project, which is the one thing this module may not hold.
 * An absent or unreadable directory contributes nothing and is not an error.
 */
function surfaceDigest(io, projectDir) {
  const parts = []
  for (const sub of WATCH_SUBDIRS) {
    const dir = join(projectDir, sub)
    let names = []
    try {
      names = (io.readdirSync(dir) || []).filter((n) => typeof n === 'string').sort()
    } catch {
      parts.push(`${sub}\u0000(absent)`)
      continue
    }
    for (const name of names) {
      let size = -1
      let mtime = -1
      try {
        const st = io.statSync(join(dir, name))
        size = Number(st && st.size)
        mtime = Number(st && st.mtimeMs)
      } catch {
        /* an entry that vanished between the readdir and the stat is simply not in the digest */
      }
      parts.push(`${sub}\u0000${name}\u0000${Number.isFinite(size) ? size : -1}\u0000${Number.isFinite(mtime) ? mtime : -1}`)
    }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/**
 * watchProject({projectDir, projectId, emit, …}) → a handle.
 *
 * Starts a debounced watch of the project's configuration and corpus directories plus the
 * periodic reconcile, and returns `{degraded, degradedReason, stopped, stop()}`. It NEVER
 * throws for a project that is missing, unreadable or on a platform without recursive watch:
 * every one of those is a degraded connection that says so, not a boot failure.
 *
 * @param {{
 *   projectDir: string,
 *   projectId?: string,
 *   emit?: (frame:object)=>void,
 *   watchImpl?: Function,             // (path, opts, listener) → {close, on?}
 *   fsImpl?: object,
 *   schedule?: (fn:Function, ms:number)=>*,        // one-shot (the debounce)
 *   cancelScheduled?: (handle:*)=>void,
 *   setTimer?: (fn:Function, ms:number)=>*,        // repeating (the reconcile)
 *   clearTimer?: (handle:*)=>void,
 *   debounceMs?: number,
 *   intervalMs?: number,
 *   onDegrade?: (reason:string)=>void,
 * }} args
 * @returns {object} the handle (pass it to stopWatch)
 */
export function watchProject({
  projectDir,
  projectId = null,
  emit,
  watchImpl,
  fsImpl,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancelScheduled = (h) => clearTimeout(h),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (h) => clearInterval(h),
  debounceMs = DEBOUNCE_MS,
  intervalMs = RECONCILE_MS,
  onDegrade,
} = {}) {
  const io = fsSeam(fsImpl)
  const watch = typeof watchImpl === 'function' ? watchImpl : fsWatch
  const dir = typeof projectDir === 'string' ? projectDir : ''

  const handle = {
    projectId,
    /** Which project this handle is actually watching — a switch makes the old one stale. */
    projectDir: dir === '' ? null : dir,
    degraded: false,
    degradedReason: null,
    stopped: false,
    watchers: [],
    reconcileTimer: null,
    pending: null,
    /** Kept so the reconcile can tell «changed» from «already announced» — a digest, never content. */
    lastDigest: dir === '' ? '' : surfaceDigest(io, dir),
  }

  /** Report a degradation EXACTLY once — the screen needs the fact, not a stream of it. */
  function degrade(reason) {
    if (handle.degraded) return
    handle.degraded = true
    handle.degradedReason = String(reason || 'watch unavailable')
    if (typeof onDegrade === 'function') {
      try {
        onDegrade(handle.degradedReason)
      } catch {
        /* a report failure never breaks the connection it was reporting on */
      }
    }
  }

  function emitHint() {
    if (handle.stopped || typeof emit !== 'function') return
    try {
      emit(projectId == null ? { event: 'project.updated' } : { event: 'project.updated', projectId })
    } catch {
      /* a hint failure never affects the read path — the poll is the truth */
    }
  }

  /** The trailing edge of the debounce window: one hint for the whole burst. */
  function fireDebounced() {
    handle.pending = null
    if (handle.stopped) return
    handle.lastDigest = dir === '' ? handle.lastDigest : surfaceDigest(io, dir)
    emitHint()
  }

  /**
   * One filesystem event. The window is armed by the FIRST event and is deliberately NOT
   * reset by the ones that follow: a resetting debounce can be starved indefinitely by a
   * continuous stream of writes, and a screen that waits for a build to finish before it
   * updates is the stale screen this module exists to avoid.
   */
  function onFsEvent() {
    if (handle.stopped || handle.pending != null) return
    handle.pending = schedule(fireDebounced, debounceMs)
  }

  /** The insurance: emit only when the surface actually moved since the last hint. */
  function reconcile() {
    if (handle.stopped || dir === '') return false
    const next = surfaceDigest(io, dir)
    if (next === handle.lastDigest) return false
    handle.lastDigest = next
    emitHint()
    return true
  }

  if (dir !== '') {
    for (const sub of WATCH_SUBDIRS) {
      try {
        const w = watch(join(dir, sub), { recursive: true, persistent: false }, onFsEvent)
        if (w && typeof w.on === 'function') {
          w.on('error', () => degrade('the watcher reported an error and was closed'))
        }
        if (w) handle.watchers.push(w)
      } catch (err) {
        // Recorded, not thrown and not retried: a missing directory, an unsupported
        // platform and a permission error all mean the same thing to the screen.
        handle.watchFailure = String((err && err.message) || err)
      }
    }
    if (handle.watchers.length === 0) {
      degrade(handle.watchFailure || 'no directory of this project could be watched')
    }
  } else {
    degrade('no project directory to watch')
  }

  handle.reconcileTimer = setTimer(reconcile, intervalMs)
  if (handle.reconcileTimer && typeof handle.reconcileTimer.unref === 'function') handle.reconcileTimer.unref()

  handle.clearTimer = clearTimer
  handle.cancelScheduled = cancelScheduled
  handle.reconcile = reconcile
  handle.stop = () => stopWatch(handle)
  return handle
}

/**
 * stopWatch(handle) — close every watcher, cancel a pending debounce and clear the
 * reconcile. Idempotent: a second call does nothing, and a hint scheduled before the stop
 * cannot fire after it.
 *
 * @param {object} handle the value returned by watchProject
 */
export function stopWatch(handle) {
  if (!handle || typeof handle !== 'object' || handle.stopped) return
  handle.stopped = true
  for (const w of handle.watchers || []) {
    try {
      if (w && typeof w.close === 'function') w.close()
    } catch {
      /* an already-closed watcher is the state we wanted */
    }
  }
  handle.watchers = []
  if (handle.pending != null && typeof handle.cancelScheduled === 'function') {
    try {
      handle.cancelScheduled(handle.pending)
    } catch {
      /* nothing to cancel is nothing to do */
    }
    handle.pending = null
  }
  if (handle.reconcileTimer != null && typeof handle.clearTimer === 'function') {
    try {
      handle.clearTimer(handle.reconcileTimer)
    } catch {
      /* same */
    }
    handle.reconcileTimer = null
  }
}

/**
 * readProjectMemory({projectDir, fsImpl}) → the connected project's corpus surface, plus the
 * generation of the corpus so the screen knows whether a migration preview is even relevant.
 *
 * The surface itself is `deriveMemory` — the read model that already exists and is already
 * asserted to carry counts, tags and pointers and never a note body. This function does not
 * reimplement it and must never start to. What it adds is the one question deriveMemory has
 * no reason to answer: how many of these notes are still written in the v1 format.
 *
 * NOTHING IS CACHED and no path travels: `projectDir` is used to read and is deliberately
 * absent from the return value (an absolute path on the wire is a disclosure,
 * and a payload that named the founder's home directory would leak it to any browser that
 * reached the front).
 *
 * @param {{projectDir?:string, fsImpl?:object}} [args]
 * @returns {object} the surface, or {absent:true}
 */
export function readProjectMemory({ projectDir, fsImpl } = {}) {
  const memoryDir = memoryDirOf(projectDir)
  if (!memoryDir) return { absent: true } // nothing connected — a valid state, not an error

  const surface = deriveMemory({ memoryDir, fsImpl })
  if (!surface || surface.absent) return { absent: true }

  const io = fsSeam(fsImpl)
  let names = []
  try {
    names = (io.readdirSync(memoryDir) || []).filter((f) => typeof f === 'string' && isNoteFile(f)).sort()
  } catch {
    names = []
  }

  let v1Count = 0
  let v2Count = 0
  let unreadable = 0
  for (const file of names) {
    let text
    try {
      text = io.readFileSync(join(memoryDir, file), 'utf8')
    } catch {
      unreadable += 1
      continue
    }
    try {
      const parsed = parseNote(String(text), { file })
      if (parsed.frontmatter == null) continue // a structural file is not a note
      if (parsed.schemaVersion === 2) v2Count += 1
      else v1Count += 1
    } catch {
      // An unparsable note is a counted fact, not a broken screen: the corpus lint owns
      // schema errors, and a settings screen that 500s over one typo is worse than a
      // screen that shows one note fewer.
      unreadable += 1
    }
  }

  const generation = v1Count > 0 && v2Count > 0 ? 'mixed' : v1Count > 0 ? 'v1' : v2Count > 0 ? 'v2' : 'empty'

  return {
    ...surface,
    generation,
    migratable: v1Count > 0,
    v1Count,
    v2Count,
    ...(unreadable > 0 ? { unreadableCount: unreadable } : {}),
  }
}

// ═══════════════ the migration preview + the per-file apply (reused) ═════════════
//
// NOT A SECOND MIGRATION. `previewMigration` and `applyProposal` are the phase-8 engine and
// they are called here, not reimplemented: the transform table, the validation, the
// consumed-draft marker and the confirmation token all stay where they were written and
// tested. What this module adds is exactly two things — WHERE the staging goes, and WHAT
// reaches the browser.
//
// WHERE THE STAGING GOES, and why it is not a detail. `previewMigration` stages a complete
// draft file per proposal; by default it stages them into `<corpus>/drafts/`, which for a
// CONNECTED project would mean the daemon writing into a tree it does not own, on a poll,
// with nobody's yes. So the staging directory is redirected to a DAEMON-OWNED folder. The
// connected project is therefore byte-identical after any number of previews — asserted by
// a snapshot of the whole fixture tree, not by this paragraph — and the only write that ever
// lands in the project is `applyProposal`, one file at a time, behind a human's approval.
//
// WHAT REACHES THE BROWSER. A proposal carries a unified DIFF, and a diff is the note's
// body. The payload contract forbids that, so the surface below carries a
// CLOSED vocabulary instead: the disposition, a reason CODE, the frontmatter keys that would
// be dropped, how many lines would move, and the validation counts. That is a real answer to
// «что изменится» with no prose on the wire — and it also means an unreadable note's raw
// error message, which can name an absolute path, never travels.

/** The closed reason vocabulary — a code the screen renders, never the engine's sentence. */
function reasonCodeOf(proposal) {
  if (proposal.disposition === 'v2-markup') return 'doctrine-record'
  if (proposal.disposition === 'episode-archive') return 'history-episode'
  const reason = String(proposal.reason || '')
  if (reason.startsWith('unreadable:')) return 'unreadable'
  if (reason.startsWith('already schema v2')) return 'already-v2'
  if (reason.startsWith('no frontmatter')) return 'structural'
  return 'skipped'
}

/** How many lines the proposal would move — the diff's size, never the diff. */
function changedLinesOf(diff) {
  let n = 0
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+') || line.startsWith('-')) n += 1
  }
  return n
}

/** One proposal, reduced to the surface a browser may see. */
function proposalSurface(p) {
  const errors = p.validation ? p.validation.errors.length : 0
  const warnings = p.validation ? p.validation.warnings.length : 0
  return {
    file: p.source_file,
    disposition: p.disposition,
    reasonCode: reasonCodeOf(p),
    droppedKeys: Array.isArray(p.dropped_keys) ? p.dropped_keys : [],
    changedLines: changedLinesOf(p.diff),
    errors,
    warnings,
    sensitive: (p.sensitivity_reasons || []).length > 0,
    hasStub: !!p.stub,
    draftStatus: p.draft_status || 'none',
    applicable: p.disposition !== 'skip' && errors === 0 && p.draft_status !== 'already-applied',
  }
}

/**
 * How large a corpus may be before the preview stops being something a POLL can carry.
 *
 * WHY A CAP AT ALL. `deriveState` runs on every GET /api/state (2-5s), and for a connected
 * project still in the older format that call ALSO ran this preview over the whole corpus:
 * read every note, build a v2 rendering, serialize it, diff it, stage a draft. For the
 * founder's real corpora — tens of small notes — that is milliseconds. It was bounded by
 * nothing at all: a connected project with a thousand old-format notes would pay for that on
 * every poll of every open window, and it is also, strictly, a write on a timer.
 *
 * WHY TWO HUNDRED. The corpus lint caps a note's size, so two hundred notes is the order of
 * magnitude of a large real corpus and roughly an order of magnitude above the founder's own
 * (34). Under it, nothing about today's behaviour changes; over it, the preview is not built
 * and the payload SAYS SO, so the screen can tell a person the corpus is too large for a
 * live preview instead of showing a section that quietly means something else.
 *
 * The honest limitation, stated where it is decided: the register's wording is «preview the
 * first N notes and say so», and the engine (`previewMigration`) takes a corpus directory
 * rather than a file list, so previewing a PART of a corpus is not something a caller can ask
 * it for. What this seam can do is refuse to start an unbounded run and name the reason.
 */
export const PREVIEW_NOTE_CAP = 200

/** How many plain notes the corpus holds — a readdir, never a read. */
function countCorpusNotes(io, corpusDir) {
  try {
    return (io.readdirSync(corpusDir) || []).filter((f) => typeof f === 'string' && isNoteFile(f)).length
  } catch {
    return 0
  }
}

/**
 * previewProjectMigration({projectDir, stagingDir, now, previewImpl, noteCap}) → the per-file
 * surface of what a migration would change, or `null` when there is nothing to preview.
 *
 * READ-ONLY WITH RESPECT TO THE CONNECTED PROJECT, by construction rather than by care: the
 * only directory the engine writes into is `stagingDir`, and that lives beside the daemon's
 * own data, never inside the project.
 *
 * BOUNDED. A corpus over `noteCap` notes is reported, not previewed: `truncated: true` with
 * the corpus size and the cap beside it. Nothing is cached either way — derive-never-store is
 * this module's founding law, and a memo of a foreign project's corpus is exactly the
 * daemon-side copy it forbids.
 *
 * @param {{projectDir?:string, stagingDir?:string, now?:Date, previewImpl?:Function, noteCap?:number, fsImpl?:object}} [args]
 * @returns {object|null}
 */
export function previewProjectMigration({ projectDir, stagingDir, now, previewImpl, noteCap = PREVIEW_NOTE_CAP, fsImpl } = {}) {
  const corpusDir = memoryDirOf(projectDir)
  if (!corpusDir || typeof stagingDir !== 'string' || stagingDir.trim() === '') return null
  const io = fsSeam(fsImpl)
  const corpusNotes = countCorpusNotes(io, corpusDir)
  const cap = Number.isFinite(noteCap) && noteCap > 0 ? noteCap : PREVIEW_NOTE_CAP

  if (corpusNotes > cap) {
    return { total: 0, applicable: 0, files: [], truncated: true, corpusNotes, previewCap: cap }
  }

  const run = typeof previewImpl === 'function' ? previewImpl : previewMigration
  let report
  try {
    report = run({ corpusDir, draftsDir: stagingDir, now })
  } catch {
    // A corpus that is not there, or one the daemon may not read, is a section the screen
    // does not show — never a wedged poll.
    return null
  }
  const proposals = (report && Array.isArray(report.proposals) ? report.proposals : []).map(proposalSurface)
  return {
    total: proposals.length,
    applicable: proposals.filter((p) => p.applicable).length,
    files: proposals,
    truncated: false,
    corpusNotes,
    previewCap: cap,
  }
}

/**
 * How long a staged migration draft is kept.
 *
 * A preview stages a COMPLETE v2 rendering of a foreign project's note — body and all —
 * beside the daemon's own data, and nothing ever deleted one. Two weeks is the retention:
 * long enough that a person who previewed a migration on Friday can still accept it after a
 * holiday, short enough that a project connected once in spring is not still on this disk in
 * the autumn. A draft that is still relevant is re-staged by the next preview, which resets
 * its age — so the window is «two weeks since anybody looked», not «two weeks since it was
 * first written».
 */
export const STAGING_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** Only the engine's own staged drafts are candidates — nothing else in the directory. */
const STAGED_DRAFT_RE = /^migration--.+\.md$/

/**
 * pruneMigrationStaging({stagingDir, now, retentionMs, fsImpl}) → {removed, kept}.
 *
 * Deletes staged drafts nobody has re-staged inside the retention window. Two things it does
 * NOT touch, both on purpose:
 *
 *   - the consumed-draft markers (`*.applied.md`). Their presence is what makes a second
 *     apply of the same proposal impossible; removing one would let an already-applied
 *     migration be applied again, which is a data question, not a housekeeping one;
 *   - anything that is not a staged draft. This directory is the daemon's, but a prune that
 *     sweeps by directory rather than by name is one rename away from deleting something else.
 *
 * An absent directory, an unreadable entry and a failed delete are all non-events: pruning is
 * housekeeping and must never be able to stop a boot or a project switch.
 *
 * @param {{stagingDir?:string, now?:number, retentionMs?:number, fsImpl?:object}} [args]
 * @returns {{removed:number, kept:number}}
 */
export function pruneMigrationStaging({ stagingDir, now = Date.now(), retentionMs = STAGING_RETENTION_MS, fsImpl } = {}) {
  const out = { removed: 0, kept: 0 }
  if (typeof stagingDir !== 'string' || stagingDir.trim() === '') return out
  const io = fsSeam(fsImpl)

  let names = []
  try {
    names = (io.readdirSync(stagingDir) || []).filter((n) => typeof n === 'string')
  } catch {
    return out // no staging directory yet is the state we wanted
  }

  for (const name of names) {
    if (!STAGED_DRAFT_RE.test(name) || name.endsWith('.applied.md')) continue
    const path = join(stagingDir, name)
    let mtime = NaN
    try {
      mtime = Number(io.statSync(path).mtimeMs)
    } catch {
      continue // an entry that vanished under us needs no deleting
    }
    if (!Number.isFinite(mtime) || now - mtime <= retentionMs) {
      out.kept += 1
      continue
    }
    try {
      io.rmSync(path, { force: true })
      out.removed += 1
    } catch {
      out.kept += 1 // a file we may not delete is one we keep, not a thrown boot
    }
  }
  return out
}

/**
 * applyProjectMigration({projectDir, stagingDir, file, now, …}) — apply ONE proposal, named
 * by the person who approved it.
 *
 * THE PER-FILE YES IS THE ARGUMENT. `file` is both the thing to apply and the confirmation
 * that it is the thing to apply: it is handed straight to `applyProposal` as the
 * `confirmFile` token, which refuses unless it names the draft's own declared source. There
 * is no bulk form of this function and there must never be one — «применить всё» has to
 * stay something a person types file by file.
 *
 * The answer carries a file NAME and a CODE. No target path travels back: the caller is a
 * request handler and the path is the founder's own directory layout.
 *
 * @param {{projectDir?:string, stagingDir?:string, file?:string, now?:Date, previewImpl?:Function, applyImpl?:Function}} [args]
 * @returns {{applied:boolean, file:string, reasonCode:string}}
 */
export function applyProjectMigration({ projectDir, stagingDir, file, now, previewImpl, applyImpl } = {}) {
  const name = typeof file === 'string' ? file : ''
  const refuse = (reasonCode) => ({ applied: false, file: name, reasonCode })

  // Checked BEFORE anything is read: a name that is not a plain corpus file is refused
  // without the engine ever seeing it.
  if (!CORPUS_FILE_RE.test(name) || name.includes('..')) return refuse('invalid-file')

  const corpusDir = memoryDirOf(projectDir)
  if (!corpusDir || typeof stagingDir !== 'string' || stagingDir.trim() === '') return refuse('no-project')

  // Re-previewing is how the draft for this file is LOCATED — the staging path convention
  // belongs to the engine, and duplicating it here is how the two would drift apart. The
  // preview is idempotent and writes nothing into the project, so this costs nothing but a
  // read (and it guarantees the draft on disk matches the corpus as it is right now).
  const runPreview = typeof previewImpl === 'function' ? previewImpl : previewMigration
  let report
  try {
    report = runPreview({ corpusDir, draftsDir: stagingDir, now })
  } catch {
    return refuse('no-corpus')
  }

  const proposal = (report && Array.isArray(report.proposals) ? report.proposals : []).find(
    (p) => p && p.source_file === name,
  )
  if (!proposal) return refuse('unknown-file')
  if (proposal.draft_status === 'already-applied') return refuse('already-applied')
  if (!proposalSurface(proposal).applicable) return refuse('not-applicable')

  const runApply = typeof applyImpl === 'function' ? applyImpl : applyProposal
  let result
  try {
    result = runApply({ draftPath: proposal.draft_path, corpusDir, confirmFile: name })
  } catch {
    return refuse('refused')
  }
  return result && result.applied
    ? { applied: true, file: name, reasonCode: 'applied' }
    : refuse('refused')
}
