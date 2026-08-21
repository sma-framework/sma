/**
 * statusline-install.mjs — the managed `statusLine` edit of .claude/settings.json.
 *
 * WHY THIS MODULE EXISTS. The install core used to live inside the CLI file, where only
 * the CLI could reach it. A command file is an entry point: importing it runs main() and
 * exits the host process, so no installer and no other module can call into it. Spawning
 * the verb instead of importing it is worse than useless from a linked working copy — the
 * state root is resolved through the SHARED git directory, so a verb spawned from a linked
 * copy writes the settings of the MAIN checkout. And copying the write into a second caller
 * is the defect class this project has already paid for once: two lists of the same thing
 * drift apart, and the drift is invisible until a user is standing on it. So there is ONE
 * implementation of the statusLine write, it lives here, and every caller imports it —
 * the verb, the wrap-preserve selftest, and the installer.
 *
 * THE NEVER-CLOBBER GUARANTEE. The `statusLine` key is the ONLY key ever mutated: every
 * other key is asserted deep-equal against the pre-edit snapshot BEFORE the write, and a
 * mismatch aborts the write entirely. A foreign command is preserved verbatim and wrapped
 * (their line prints first, our segment second); uninstall gives it back byte-for-byte, or
 * removes the key when we were the ones who added it. A file that fails strict JSON.parse
 * is never written at all — the caller prints a snippet instead.
 *
 * Node built-ins only; zero npm deps.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { isSmaStatuslineCmd } from './statusline.mjs'

/** The canonical statusLine command this repo installs, and its wrap variant.
 *
 * ANCHORED to the project root — `${CLAUDE_PROJECT_DIR:-.}` — for the same reason every
 * hook command is: the harness runs this string as a one-shot process whose working
 * directory it inherits from the session, so a path written relative to the project makes
 * node fail to resolve the module before any of this code runs, and the segment simply
 * disappears. Where the variable is unset the fallback `.` is byte-for-byte the spelling
 * this constant used to hold, so nothing is ever worse than it was. The path is quoted so
 * a project directory with spaces in it stays one argument.
 *
 * Changing this string means teaching isSmaStatuslineCmd (both copies of it — the render
 * one and the off-ramp's deliberate standalone) to still recognise the previous spelling:
 * an install that reads its OWN yesterday's line as a stranger's PRESERVES and WRAPS it,
 * which spawns this CLI twice on every repaint and then hands our own copy back at
 * uninstall as though it were the adopter's. */
export const SMA_STATUSLINE_CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/sma/cli.mjs" statusline'
export const SMA_STATUSLINE_WRAP_CMD = SMA_STATUSLINE_CMD + ' --wrap'

/**
 * STATUSLINE_REFRESH_SECONDS — how often Claude Code re-runs the statusLine command on its
 * own timer, written into the entry by the install.
 *
 * WHY A TIMER IS NOT OPTIONAL: the segment has to show what is happening across the whole
 * machine — a claim taken in a neighbouring window, a gate opened by someone else — and
 * event-driven repaints only ever touch the window where the conversation is happening. An
 * idle window would never learn about anything. Sixty seconds is four times the fast cache
 * TTL, so the timer does not spin on values that cannot have changed, and four times under
 * the slow one. The price is named out loud rather than hidden: once a minute each open
 * window spawns this process, and with it the adopter's own wrapped command, which is user
 * code and deliberately not cached.
 */
export const STATUSLINE_REFRESH_SECONDS = 60

/**
 * canonicalStatuslineEntry(cmd) — the exact object an install writes into settings.statusLine.
 * Exported so callers and tests assert the shape against ONE definition instead of retyping
 * the literal (a retyped literal is how two lists drift apart).
 */
export function canonicalStatuslineEntry(cmd) {
  return { type: 'command', command: cmd, padding: 0, refreshInterval: STATUSLINE_REFRESH_SECONDS }
}

/** Key-order-insensitive structural comparison — a settings file written by hand may carry
 * the same entry with its keys in any order, and that is not a difference worth a rewrite. */
function sameEntry(a, b) {
  const stable = (v) =>
    JSON.stringify(v, (_k, val) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.keys(val)
            .sort()
            .reduce((o, key) => {
              o[key] = val[key]
              return o
            }, {})
        : val,
    )
  return stable(a) === stable(b)
}

/**
 * applyStatuslineInstall(sub, {settingsPath, dirs, by, now}) — the install/uninstall CORE.
 * Returns {status, wrote} with status one of
 * installed | installed-wrap | noop-already | uninstalled | noop-absent | parse-failed.
 * NEVER throws; on an unparseable file it writes NOTHING and returns 'parse-failed'.
 */
export async function applyStatuslineInstall(sub, { settingsPath, dirs, by, now }) {
  let raw = ''
  try {
    raw = readFileSync(settingsPath, 'utf8')
  } catch {
    raw = '' // absent file -> treated as empty settings
  }
  let settings
  let before
  if (raw.trim()) {
    try {
      settings = JSON.parse(raw)
      before = JSON.parse(raw) // independent copy for the deep-equal assertion
    } catch {
      return { status: 'parse-failed', wrote: false } // strict-parse-or-print-snippet: write NOTHING
    }
  } else {
    settings = {}
    before = {}
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { status: 'parse-failed', wrote: false }

  const existing = settings.statusLine
  const existingCmd = existing && typeof existing === 'object' ? existing.command : typeof existing === 'string' ? existing : null
  const wrappedPath = join(dirs.statuslineDir, 'wrapped-command.json')

  if (sub === 'install') {
    if (existing && isSmaStatuslineCmd(existingCmd)) {
      // Already ours — but possibly in an OUTDATED SHAPE. An entry written before the
      // refresh timer existed carries no refreshInterval, and such a window would never
      // repaint for anything raised outside it. So 'already installed' is decided by the
      // ENTRY, not by the command alone: identical to the canonical entry of the shape it
      // already has -> nothing to do; anything else -> heal it to that canonical entry.
      // wrapped-command.json is NOT touched while healing: it may hold the adopter's own
      // command, saved verbatim by the install that wrapped it, and rewriting it with
      // hadNone would destroy the only copy of a line we promised to give back.
      const isWrap = String(existingCmd).includes('--wrap')
      const canonical = canonicalStatuslineEntry(isWrap ? SMA_STATUSLINE_WRAP_CMD : SMA_STATUSLINE_CMD)
      if (sameEntry(existing, canonical)) return { status: 'noop-already', wrote: false } // idempotent
      settings.statusLine = canonical
      if (!writeSettingsStatusLineOnly(settingsPath, settings, before)) return { status: 'parse-failed', wrote: false }
      return { status: isWrap ? 'installed-wrap' : 'installed', wrote: true }
    }
    let status
    if (!existing) {
      settings.statusLine = canonicalStatuslineEntry(SMA_STATUSLINE_CMD)
      try {
        atomicWriteJson(wrappedPath, { hadNone: true, savedAt: new Date(now).toISOString(), by })
      } catch {
        /* fail-open — worst case uninstall leaves the key; harmless */
      }
      status = 'installed'
    } else {
      // preserve the foreign command verbatim, then wrap it
      try {
        atomicWriteJson(wrappedPath, { command: existingCmd, original: existing, hadNone: false, savedAt: new Date(now).toISOString(), by })
      } catch {
        /* fail-open */
      }
      settings.statusLine = canonicalStatuslineEntry(SMA_STATUSLINE_WRAP_CMD)
      status = 'installed-wrap'
    }
    if (!writeSettingsStatusLineOnly(settingsPath, settings, before)) return { status: 'parse-failed', wrote: false }
    return { status, wrote: true }
  }

  // uninstall
  const stored = readJsonSafe(wrappedPath) || {}
  if (stored.hadNone) {
    delete settings.statusLine
  } else if (stored.original !== undefined) {
    settings.statusLine = stored.original // verbatim restore
  } else if (existing && isSmaStatuslineCmd(existingCmd)) {
    delete settings.statusLine // no record but ours is present -> remove
  } else {
    return { status: 'noop-absent', wrote: false }
  }
  if (!writeSettingsStatusLineOnly(settingsPath, settings, before)) return { status: 'parse-failed', wrote: false }
  return { status: 'uninstalled', wrote: true }
}

/**
 * writeSettingsStatusLineOnly(path, settings, before) — assert every NON-statusLine key is
 * deep-equal to the pre-edit snapshot, then write with 2-space indent. If any other key would
 * change, abort WITHOUT writing (return false) — the never-clobber guarantee.
 */
export function writeSettingsStatusLineOnly(path, settings, before) {
  try {
    const strip = (o) => {
      const c = { ...(o && typeof o === 'object' ? o : {}) }
      delete c.statusLine
      return c
    }
    if (JSON.stringify(strip(settings)) !== JSON.stringify(strip(before))) return false // a foreign key moved -> abort
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}
