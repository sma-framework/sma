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
 * happen to coincide, no «probably the same person». Node built-ins only; env + homedir
 * injectable so a test never depends on the machine it runs on.
 */

import { join } from 'node:path'
import { homedir as osHomedir } from 'node:os'

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
