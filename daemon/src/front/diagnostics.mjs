/**
 * diagnostics.mjs — the five facts a bug report is allowed to carry, and NOTHING else.
 *
 * ═══════════════════════ WHY THIS IS ITS OWN MODULE ══════════════════════════════
 * The feedback window's channel is a PUBLIC GitHub issue: whatever this function returns
 * is read by a person who then presses «create issue», and from that moment it is on the
 * open internet forever. So the shape is not «a helpful dump minus the sensitive bits» —
 * it is an EXPLICIT PICK of five values, assembled here by name:
 *
 *   version   — which SMA is installed (from capability.json, the single version source)
 *   platform  — which operating system family (os.platform())
 *   release   — which release of it (os.release())
 *   node      — which Node runtime (process.version)
 *   unknownDispatchCodes — the routing reason codes this daemon could not sign
 *
 * ═══════════════ THE FIFTH FIELD, ARGUED FOR RATHER THAN ASSUMED ═════════════════
 * The header below demands a SENTENCE from anyone who widens this list, so here is one.
 * The field carries reason CODES — string literals written in the product's own sources —
 * which the router handed to the decision journal and the closed vocabulary refused. It is
 * bounded in how many it may carry and in how long each may be, and by construction nothing
 * else can reach it: no path, no project name or id, no task title, no queue or memory
 * content — only a word a programmer typed into this repository. Against that cost stands
 * the exact bug report this module exists to serve — «окно не показывает, почему задача не
 * пошла» — whose one useful fact IS which word went unsigned. A person filing that report
 * cannot be sent to read the daemon's log first; the window has to carry it.
 *
 * WHAT MAY NEVER APPEAR HERE, stated so a later reader has to argue with a sentence
 * rather than with a habit: no filesystem path (not the config's, not the repository's,
 * not the daemon's own), no project name and no project id, no task title, no queue or
 * memory content, no env-var NAME and obviously no env-var value, no token, no machine
 * id, no peer address. None of the four fields above can carry any of them, and the suite
 * asserts the key set is EXACTLY those four — not «contains», not «does not contain the
 * bad ones»: a whitelist compared for equality is the only check that survives a later
 * field being added by someone who meant well.
 *
 * THE VERSION COMES FROM THE PACKAGE THAT SHIPS THIS DAEMON, never from the repository the
 * daemon happens to be serving: the path is resolved from THIS module's own url, exactly
 * the way server.mjs resolves its static build directory. A daemon serving somebody else's
 * project must report ITS OWN version, and a repoDir-derived answer would report theirs.
 *
 * An unreadable capability.json yields `version: null` — an honest absence. It never
 * yields the path it tried, and it never throws: a person who cannot open the feedback
 * window cannot report the bug that broke it.
 *
 * Node built-ins only, and every source (the file, the os, the process) is injectable, so
 * the suite reads no real tree and asserts on values it chose itself. Zero deps.
 */

import { readFileSync as fsReadFileSync } from 'node:fs'
import { platform as osPlatform, release as osRelease } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * THE WHITELIST, as data. Exported because the equality test reads it from here rather
 * than retyping it: a test that carries its own copy of the answer proves the author
 * agrees with himself. The ORDER is also the order of the returned object, so a serialized
 * diagnostic reads the same way every time.
 */
export const DIAGNOSTIC_KEYS = Object.freeze(['version', 'platform', 'release', 'node', 'unknownDispatchCodes'])

/** How many unsigned codes may ride a public issue, and how long each may be. */
export const UNKNOWN_CODES_IN_DIAGNOSTIC_CAP = 20
export const UNKNOWN_CODE_LENGTH_CAP = 64

/**
 * Where the product states its own version — `sma-core/capabilities/sma/capability.json`,
 * the single version source the whole product already obeys (the installer stamps it, the
 * updater compares it, package-check pins package.json to it). Resolved from this module's
 * own url so the daemon reports the version of the package it was installed as, wherever
 * that package lives on disk.
 */
const CAPABILITY_PATH = fileURLToPath(new URL('../../../sma-core/capabilities/sma/capability.json', import.meta.url))

/**
 * The unsigned codes, made safe to quote a SECOND time — the register already caps itself,
 * and this caps it again on the way out. Not belt-and-braces for its own sake: the register
 * lives in another module, and a bound that only exists at the source is a bound that leaves
 * with the next refactor of the source. Anything that is not a non-empty string is dropped.
 */
function safeUnknownCodes(read) {
  if (typeof read !== 'function') return []
  let raw
  try {
    raw = read()
  } catch {
    // A reader that throws costs the person nothing: the other four facts still travel, and
    // a window that cannot be opened cannot report the bug that broke it.
    return []
  }
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') continue
    out.push(item.slice(0, UNKNOWN_CODE_LENGTH_CAP))
    if (out.length >= UNKNOWN_CODES_IN_DIAGNOSTIC_CAP) break
  }
  return out
}

/**
 * collectDiagnostics(opts) → {version, platform, release, node, unknownDispatchCodes} —
 * EXACTLY those five keys.
 *
 * @param {{capabilityPath?:string, osImpl?:object, processImpl?:object, fsImpl?:object, unknownDispatchCodesImpl?:()=>string[]}} [opts]
 * @returns {{version:(string|null), platform:string, release:string, node:string, unknownDispatchCodes:string[]}}
 */
export function collectDiagnostics({ capabilityPath = CAPABILITY_PATH, osImpl, processImpl, fsImpl, unknownDispatchCodesImpl } = {}) {
  const readFileSync = (fsImpl && fsImpl.readFileSync) || fsReadFileSync
  const platform = (osImpl && osImpl.platform) || osPlatform
  const release = (osImpl && osImpl.release) || osRelease
  const proc = processImpl || process

  let version = null
  try {
    const parsed = JSON.parse(String(readFileSync(capabilityPath, 'utf8')))
    // The one field that is read. A capability file that grows a `path`, a `source` or an
    // `installedFrom` must not start riding a public issue because the whole object was
    // spread into the answer.
    if (parsed && typeof parsed.version === 'string' && parsed.version !== '') version = parsed.version
  } catch {
    // An absent / unparseable stamp is a legitimate state (a checkout, a partial install).
    // The reason is NOT reported: an fs error message contains the path it failed on, which
    // is the first thing this module exists to keep out of a public issue.
    version = null
  }

  // Assembled BY NAME, one line per key. Not a spread, not a filter over a bigger object:
  // a filter can be widened by accident, a hand-written literal cannot.
  return {
    version,
    platform: String(platform()),
    release: String(release()),
    node: String(proc.version ?? ''),
    // Empty when nothing went unsigned — which is the state a healthy install stays in, and
    // an empty array says so more plainly than an absent key.
    unknownDispatchCodes: safeUnknownCodes(unknownDispatchCodesImpl),
  }
}
