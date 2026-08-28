/**
 * config-dir.mjs — WHICH subscription is this session signed into, and are two of them one.
 *
 * WHY THIS EXISTS AT ALL. A window reading says how much of a plan is left; it does not say
 * WHOSE plan. The provider's status-line payload names no account, and the work stream names
 * no account either — the daemon knows which one it spawned because it spawned it. So a
 * reading taken in one place could never be shown in another without a guess, and the window
 * module refuses guesses: for months the terminal's own reading — the ONLY one that carries a
 * percentage — sat in the store next to account rows that said «нет данных».
 *
 * There is a fact that answers it, and it was already on both sides. Claude Code keeps
 * everything about one signed-in account under a config directory, and the fleet gives every
 * account its own: the daemon spawns a worker with `CLAUDE_CONFIG_DIR=<account.configDir>`
 * (runner/args.mjs), and a status line running inside that session inherits the very same
 * variable. Two readings whose config directory is the same directory are two readings of ONE
 * subscription — not a likely pair, the same one. Two readings whose directories differ stay
 * apart, and the screen keeps saying «нет данных», which is the honest answer for a plan
 * nobody has measured.
 *
 * The rule is deliberately identity, never resemblance: no matching on reset times that
 * happen to coincide, no «probably the same person».
 *
 * ONE SUBSCRIPTION CAN HAVE TWO DOORS, AND THE DIRECTORY RULE ALONE CALLS THEM STRANGERS.
 * The person's own terminal keeps its account under the default directory; the daemon hands
 * the fleet a directory of its own ON PURPOSE, so the workers get a history that is not the
 * person's. Same account, same plan, two directories — and the screen then shows a worker
 * card saying «нет данных» about a five-hour window that was measured a minute earlier by the
 * terminal, one file away. Measured on the reference machine: the weekly line arrived and the
 * five-hour one did not, because the work stream only ever reports the window closest to
 * biting and the other quietly ages back to unknown.
 *
 * The answer is NOT to loosen the rule — a loose rule starts attributing one person's plan to
 * another person's account, which is the whole failure the rule exists to prevent. It is that
 * a SECOND fact of the same kind is already written on both sides, by the vendor, in each
 * directory's own files: Claude Code records the signed-in account as
 * `oauthAccount.accountUuid` in the `.claude.json` belonging to that config directory. Two
 * directories whose own files name the same account uuid are two doors into ONE subscription —
 * again not a likely pair, the same one. Each side reads only its OWN file; no human tells
 * either side about the other.
 *
 * SO THERE ARE TWO SIGNALS AND THEY RANK: the directory first, the account uuid second. What
 * is still refused is unchanged and deliberately named — no matching on reset times that
 * happen to coincide (two plans bought the same afternoon roll over together and are not one
 * plan), and no hand-kept list of «treat these two as the same» (right on the day it is
 * written, silently wrong every day after). Both of those fail without saying so. And an
 * ABSENT uuid matches nothing, exactly as an absent directory does: two absences are two
 * absences, never a match.
 *
 * Node built-ins plus the zero-dep fs helper next door; env, homedir and the file reader are
 * injectable so a test never depends on the machine it runs on.
 */

import { join, dirname } from 'node:path'
import { homedir as osHomedir } from 'node:os'
import { statSync } from 'node:fs'

import { readJsonSafe } from './fs-atomics.mjs'

/**
 * resolveConfigDir({env, homedirFn}) → the config directory THIS process's Claude session is
 * signed into, resolved the way Claude Code itself resolves it: `CLAUDE_CONFIG_DIR` when set,
 * else `~/.claude`. Null only when neither can be established (no home, no override) — and a
 * null here means «do not attribute», never «attribute to the default».
 *
 * @param {{env?:object, homedirFn?:Function}} [opts]
 * @returns {string|null}
 */
export function resolveConfigDir({ env = process.env, homedirFn = osHomedir } = {}) {
  try {
    const override = env && env.CLAUDE_CONFIG_DIR
    if (override && String(override).trim()) return String(override).trim()
    const home = homedirFn()
    return home ? join(home, '.claude') : null
  } catch {
    return null // fail-open — an unresolvable identity attributes nothing
  }
}

/**
 * sameConfigDir(a, b) → do these two paths name ONE config directory?
 *
 * Separator spelling and a trailing slash are noise: the same directory arrives as
 * `C:\x\local-1` from an environment variable and as `C:/x/local-1/` from a JSON file
 * somebody hand-edited. Case is noise on Windows, where these paths live, and comparing
 * case-insensitively costs a false match only between two accounts whose directories differ
 * by nothing but capitalisation — a pair no one has, against a real defect everyone would
 * have hit. Anything that is not a non-empty string is not a directory, and matches nothing:
 * absent identity must NOT collapse two absences into a match.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameConfigDir(a, b) {
  const x = normalizeConfigDir(a)
  const y = normalizeConfigDir(b)
  if (!x || !y) return false
  return x === y
}

/** The comparable form of a config-dir path, or null when it is not one. */
export function normalizeConfigDir(dir) {
  if (typeof dir !== 'string') return null
  const trimmed = dir.trim()
  if (!trimmed) return null
  const slashed = trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
  return slashed ? slashed.toLowerCase() : null
}

/**
 * Where the vendor's own account file lives for one config directory. With `CLAUDE_CONFIG_DIR`
 * pointing somewhere, Claude Code keeps `.claude.json` INSIDE that directory; for the DEFAULT
 * directory — the `~/.claude` a person's own terminal uses — the file sits beside it, as
 * `~/.claude.json`. Both layouts were read on the reference machine, and each named its
 * account.
 *
 * THE SECOND PLACE IS LIMITED TO THE DEFAULT LAYOUT ON PURPOSE, by the directory's own name.
 * Looking one level up from any directory would read the HOME account for a login placed
 * directly under the home directory — attributing one person's plan to an account that merely
 * lives next to it, which is the exact misattribution this module exists to make impossible.
 * A named override keeps its file inside itself or has none.
 */
function accountFileCandidates(configDir) {
  const dir = typeof configDir === 'string' ? configDir.trim() : ''
  if (!dir) return []
  const files = [join(dir, '.claude.json')]
  const normalized = normalizeConfigDir(dir)
  if (normalized && normalized.endsWith('/.claude')) files.push(join(dirname(dir), '.claude.json'))
  return files
}

/**
 * readAccountUuid({configDir, readFn}) → the account THIS config directory is signed into, as
 * the vendor itself recorded it, or null when the directory does not say.
 *
 * Null is a real answer and never a soft one: a directory whose file is missing, unreadable,
 * malformed, or simply written before the vendor kept this field has NO identity here, and an
 * absent identity must match nothing (see sameAccountUuid).
 *
 * @param {{configDir?:string, readFn?:Function}} [opts]
 * @returns {string|null}
 */
export function readAccountUuid({ configDir, readFn } = {}) {
  try {
    for (const file of accountFileCandidates(configDir)) {
      const uuid = uuidFromFile(file, readFn)
      if (uuid) return uuid
    }
    return null
  } catch {
    return null // fail-open — an unreadable identity attributes nothing
  }
}

/**
 * The account file is large (tens of kilobytes of the vendor's own state) and this question is
 * asked on every poll of the team screen, once per worker. So the answer is memoised against
 * what the filesystem says about the file — its mtime and its size — which means the memo
 * cannot outlive a rewrite of the file it came from. It is consulted ONLY when the real
 * filesystem is what is being read: an injected reader (a test, a fixture) always goes to the
 * reader, because there is no file behind it for the stamp to be about.
 * @type {Map<string, {mtimeMs:number, size:number, uuid:string|null}>}
 */
const uuidByFile = new Map()

/** `oauthAccount.accountUuid` out of one account file, memoised on its mtime+size. */
function uuidFromFile(file, readFn) {
  let stamp = null
  if (!readFn) {
    try {
      const st = statSync(file)
      stamp = { mtimeMs: st.mtimeMs, size: st.size }
      const hit = uuidByFile.get(file)
      if (hit && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size) return hit.uuid
    } catch {
      return null // no such file here — try the next candidate
    }
  }
  const parsed = readJsonSafe(file, readFn ? { readFn } : undefined)
  const account = parsed && typeof parsed === 'object' ? parsed.oauthAccount : null
  const uuid = normalizeAccountUuid(account && typeof account === 'object' ? account.accountUuid : null)
  if (stamp) uuidByFile.set(file, { ...stamp, uuid })
  return uuid
}

/**
 * sameAccountUuid(a, b) → do these two readings name ONE signed-in account?
 *
 * The SECOND identity signal, ranked below the directory and held to the same standard: it is
 * a comparison of a fact each side read out of its own files, so equality here is the identity
 * of one subscription rather than a resemblance between two. Anything that is not a non-empty
 * string is not an identity and matches nothing — two absent uuids are two absences, and
 * collapsing them into a match would attribute one stranger's plan to another's account, which
 * is the exact failure this whole module refuses.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameAccountUuid(a, b) {
  const x = normalizeAccountUuid(a)
  const y = normalizeAccountUuid(b)
  if (!x || !y) return false
  return x === y
}

/** The comparable form of an account uuid, or null when it is not one. Hex, so case is noise. */
export function normalizeAccountUuid(uuid) {
  if (typeof uuid !== 'string') return null
  const trimmed = uuid.trim().toLowerCase()
  return trimmed || null
}
