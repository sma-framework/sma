/**
 * local-store.mjs — the this-machine-only memory store: where material that must
 * never enter git physically lives.
 *
 * WHY A LOCATION AND NOT A FILTER. A corpus reader lists the corpus directory
 * and keeps the regular `.md` files in it (generator.mjs `listNoteFiles`). This
 * store therefore sits OUTSIDE that directory — under the installation's own
 * `.sma/` state root — rather than inside it behind an exclusion rule. A filter
 * is a rule someone can forget to apply in the next reader that gets written; a
 * location is not.
 *
 * WHY THE STORE IGNORES ITSELF. On creation it writes its own ignore marker
 * INSIDE itself: a directory that ignores its own contents, the marker included.
 * Relying on a repository-level ignore file would put the boundary in a file the
 * user edits, in a repository the user may have cloned before the boundary
 * existed — and a record that reached a commit is in the history and in every
 * clone, with no honest way back. The marker travels with the directory instead.
 * A marker somebody deleted is restored; a marker whose content DIFFERS is left
 * exactly as it is and the difference is reported, because the difference is
 * probably somebody tightening the rule and this module has no business
 * loosening it.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not encrypt. `encrypted-required` states
 * a requirement, and the cipher decision is open and carried separately
 * (docs/MEMORY-THREAT-MODEL.md §6). What is enforced here is PLACEMENT: the
 * material never enters a git-backed path in the first place, which is the half
 * that cannot be added retroactively.
 *
 * PURITY POSTURE, as write-pipeline.mjs states it: filesystem effects live in
 * named places only. Here that place is `ensureLocalStore` and nothing else —
 * `localStorePath` is a path computation that creates nothing. Node built-ins
 * only; every fs call is dependency-injectable.
 */

import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  renameSync as fsRenameSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { SMA_ROOT } from './constants.mjs'
import { atomicWriteRaw } from './fs-atomics.mjs'

/** The store's directory name, under the installation's `.sma/` state root. */
export const LOCAL_STORE_DIRNAME = 'local-memory'

/** The ignore marker's filename — git's own, so no tooling has to learn a new one. */
export const LOCAL_STORE_MARKER = '.gitignore'

/**
 * The marker's content. The bare `*` is the whole mechanism: it ignores every
 * path in this directory, the marker itself included, so the directory cannot
 * be committed even by someone who never read this file.
 */
export const LOCAL_STORE_MARKER_TEXT = [
  '# This-machine-only memory. Nothing in this directory may enter git — not the',
  '# records, and not this file either. The boundary lives HERE, inside the store,',
  '# rather than in a repository-level ignore file: that file is one a person edits,',
  '# in a repository a person may have cloned before the boundary existed. A record',
  '# that reached a commit is in the history and in every clone of it.',
  '*',
  '',
].join('\n')

/**
 * localStorePath({repoRoot}) -> the store's directory.
 *
 * PURE: it computes a path and creates nothing. The path is deliberately outside
 * the corpus directory (`.claude/memory`), so no corpus reader walks it.
 *
 * @param {{repoRoot?: string}} [opts]
 * @returns {string}
 */
export function localStorePath(opts = {}) {
  const repoRoot = typeof opts.repoRoot === 'string' && opts.repoRoot.trim() ? opts.repoRoot : '.'
  return join(repoRoot, SMA_ROOT, LOCAL_STORE_DIRNAME)
}

/**
 * ensureLocalStore({repoRoot, fsImpl}) -> report
 *
 * THE ONE FILESYSTEM EFFECT IN THIS MODULE. Creates the store on first use and
 * makes sure it carries its ignore marker. Idempotent by construction: a second
 * call over an unchanged store writes nothing at all.
 *
 * @param {{repoRoot?: string, fsImpl?: object}} [opts]
 * @returns {{path: string, markerPath: string, created: boolean,
 *            marker: 'written'|'unchanged'|'differs', wrote: boolean, note: string|null}}
 */
export function ensureLocalStore(opts = {}) {
  const fs = opts.fsImpl ?? {}
  const existsSync = fs.existsSync ?? fsExistsSync
  const mkdirSync = fs.mkdirSync ?? fsMkdirSync
  const readFileSync = fs.readFileSync ?? fsReadFileSync
  const writeFileSync = fs.writeFileSync ?? fsWriteFileSync
  const renameSync = fs.renameSync ?? fsRenameSync

  const path = localStorePath(opts)
  const markerPath = join(path, LOCAL_STORE_MARKER)

  const created = !existsSync(path)
  if (created) mkdirSync(path, { recursive: true })

  if (existsSync(markerPath)) {
    let current = null
    try {
      current = readFileSync(markerPath, 'utf8')
    } catch {
      current = null
    }
    if (current !== null && normalizeMarker(current) === normalizeMarker(LOCAL_STORE_MARKER_TEXT)) {
      return { path, markerPath, created, marker: 'unchanged', wrote: false, note: null }
    }
    // Somebody changed it. Almost certainly they tightened it, and a module that
    // silently overwrote that would be loosening a boundary on its own authority.
    return {
      path,
      markerPath,
      created,
      marker: 'differs',
      wrote: false,
      note: `${markerPath} differs from the marker this store writes — it was left exactly as it is; check that it still ignores everything in this directory`,
    }
  }

  // Missing, or never written: write it through the one atomic primitive, so a
  // reader sees no marker or the whole marker and never half of one.
  atomicWriteRaw(markerPath, LOCAL_STORE_MARKER_TEXT, {
    mkdirFn: mkdirSync,
    writeFn: writeFileSync,
    renameFn: renameSync,
  })
  return { path, markerPath, created, marker: 'written', wrote: true, note: null }
}

/** Line-ending and trailing-whitespace differences are not content differences. */
function normalizeMarker(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd()
}
