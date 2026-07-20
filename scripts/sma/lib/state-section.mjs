/**
 * state-section.mjs — the machine-managed STATE.md section (9.1-19, D-9.1-14).
 *
 * STATE.md was rewritten under executors repeatedly during P49 (the B6 conflict
 * class). D-9.1-14's answer is a FENCED region wrapping the three contended
 * zones — `## Current Position`, `## Open Blockers`, `## Active Sessions` — that is
 * written ONLY through these snapshot-semantics verbs. A git merge driver was
 * explicitly REJECTED; a single sanctioned writer + a re-read-before-write guard
 * makes the hot file race-resistant without one (RESEARCH Open Question 2, Pitfall 4).
 *
 * SNAPSHOT HOUSE RULES (CLAUDE.md — enforced mechanically here, not by prose):
 *   - `## Current Position` is OVERWRITTEN, never appended (setPosition splices the
 *     body in place → exactly one heading always survives).
 *   - Blockers are one bullet per line in the parser's exact shape
 *     `- **Phase N blocked:** <what> — <how to clear> (kind)` so src/crm/project-tracker/
 *     parse-state.ts keeps attaching them to the right phase card.
 *   - Active Sessions is APPEND-style (augment-not-clobber): setSessions adds one
 *     bullet, never rewrites a sibling terminal's entry.
 *
 * CONTRACT:
 *   - readSection(opts) → the raw region string between the fence markers.
 *   - writeSection(region, opts) → splice a region back atomically (round-trip base).
 *   - setPosition/addBlocker/resolveBlocker/setSessions → the four snapshot verbs.
 *   Every mutation returns {ok:true} on success or {ok:false, retry, reason} — the
 *   re-read-before-write guard aborts (retry:true) on a concurrent out-of-band change
 *   rather than clobbering it. Content OUTSIDE the fence is spliced through byte-for-byte.
 *
 * Atomic write reuses fs-atomics' Windows-safe renameWithRetry (same-dir temp →
 * rename); the raw-text staging lives here because fs-atomics only ships a JSON writer.
 * Node built-ins only; every fs call is dependency-injectable for tests.
 */

import {
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  mkdirSync as fsMkdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { renameWithRetry } from './fs-atomics.mjs'

/** The fence markers — inert HTML comments carrying the SMA-MANAGED sentinel. */
export const FENCE_START = '<!-- SMA-MANAGED:START -->'
export const FENCE_END = '<!-- SMA-MANAGED:END -->'

// ── raw-text atomic write (mirrors fs-atomics.atomicWriteJson for a string) ─────

/**
 * atomicWriteText(targetPath, text, opts) — write raw text atomically: mkdir the
 * parent, stage a SAME-DIR `.tmp-*` sibling, then renameWithRetry over the target
 * (RESEARCH Pattern 4 — never the OS temp dir; a cross-volume rename is not atomic).
 */
function atomicWriteText(targetPath, text, opts = {}) {
  const mkdirFn = opts.mkdirFn ?? fsMkdirSync
  const writeFn = opts.writeFn ?? fsWriteFileSync
  const dir = dirname(targetPath)
  mkdirFn(dir, { recursive: true })
  const tmpPath = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  writeFn(tmpPath, text)
  renameWithRetry(tmpPath, targetPath, { renameFn: opts.renameFn })
}

// ── pure region helpers (string in, string out) ─────────────────────────────────

/**
 * splitRegion(raw) → {before, region, after}. `before` includes the START marker,
 * `after` includes the END marker, `region` is everything strictly between them.
 * before + region + after === raw (byte-exact). Throws when the fence is missing.
 */
export function splitRegion(raw) {
  const startIdx = raw.indexOf(FENCE_START)
  if (startIdx === -1) throw new Error('state-section: SMA-MANAGED fence start marker not found')
  const afterStart = startIdx + FENCE_START.length
  const endIdx = raw.indexOf(FENCE_END, afterStart)
  if (endIdx === -1) throw new Error('state-section: SMA-MANAGED fence end marker not found')
  return {
    before: raw.slice(0, afterStart),
    region: raw.slice(afterStart, endIdx),
    after: raw.slice(endIdx),
  }
}

/** Match a `## <name>` heading LINE (heading text may carry a suffix e.g. "(multi-terminal)"). */
function sectionHeadingRe(name) {
  return new RegExp('^##\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*$', 'm')
}

/**
 * sectionBounds(region, name) → {headingEnd, bodyEnd} within the region, or null.
 * headingEnd = index just after the heading text (before its newline); bodyEnd =
 * index of the NEXT top-level `## ` heading (a `### ` subsection is NOT a boundary)
 * or the region end. The body is region.slice(headingEnd, bodyEnd).
 */
function sectionBounds(region, name) {
  const m = sectionHeadingRe(name).exec(region)
  if (!m) return null
  const headingEnd = m.index + m[0].length
  const rest = region.slice(headingEnd)
  const nm = /\n## /.exec(rest) // next `## ` heading; `\n### ` never matches (needs a space after ##)
  const bodyEnd = nm ? headingEnd + nm.index : region.length
  return { headingEnd, bodyEnd }
}

/**
 * setPositionBody(region, phase, text) — OVERWRITE the Current Position body with a
 * single parser-friendly `**Phase: <phase> — <text>**` line (snapshot house rule).
 */
function setPositionBody(region, phase, text) {
  const b = sectionBounds(region, 'Current Position')
  if (!b) throw new Error('state-section: `## Current Position` heading not found inside the fence')
  const body = `\n\n**Phase: ${phase} — ${text}**`
  return region.slice(0, b.headingEnd) + body + region.slice(b.bodyEnd)
}

/** addBlockerBullet(region, phase, text, kind) — append one parser-shaped bullet. */
function addBlockerBullet(region, phase, text, kind) {
  const b = sectionBounds(region, 'Open Blockers')
  if (!b) throw new Error('state-section: `## Open Blockers` heading not found inside the fence')
  const bullet = `- **Phase ${phase} blocked:** ${text} (${kind})`
  return region.slice(0, b.bodyEnd) + bullet + '\n' + region.slice(b.bodyEnd)
}

/** resolveBlockerBullet(region, match) — drop the single bullet line containing `match`. */
function resolveBlockerBullet(region, match) {
  const b = sectionBounds(region, 'Open Blockers')
  if (!b) throw new Error('state-section: `## Open Blockers` heading not found inside the fence')
  const body = region.slice(b.headingEnd, b.bodyEnd)
  const kept = body
    .split('\n')
    .filter((line) => !(line.trimStart().startsWith('-') && line.includes(match)))
    .join('\n')
  return region.slice(0, b.headingEnd) + kept + region.slice(b.bodyEnd)
}

/**
 * addSessionBullet(region, name, owns) — APPEND one session bullet inside Active
 * Sessions, before any `### ` subsection (augment-not-clobber: never rewrites a
 * sibling terminal's line). Boundary = the first `\n## ` OR `\n### ` after the heading.
 */
function addSessionBullet(region, name, owns) {
  const m = sectionHeadingRe('Active Sessions').exec(region)
  if (!m) throw new Error('state-section: `## Active Sessions` heading not found inside the fence')
  const headingEnd = m.index + m[0].length
  const rest = region.slice(headingEnd)
  const nm = /\n#{2,3} /.exec(rest) // stop at the next `## ` OR `### ` (Quick Tasks subsection)
  const boundary = nm ? headingEnd + nm.index : region.length
  const bullet = `- **${name}:** ${owns}`
  return region.slice(0, boundary) + bullet + '\n' + region.slice(boundary)
}

// ── the re-read-before-write guard + the file-level verbs ───────────────────────

/**
 * mutate(transform, opts) — read the file, apply a PURE `transform(raw) → newRaw`,
 * then re-read immediately before writing; if the on-disk content changed between the
 * two reads (a concurrent out-of-band writer) ABORT with {ok:false, retry:true} rather
 * than clobbering. On a clean read the new content is written atomically.
 */
function mutate(transform, opts = {}) {
  const readFn = opts.readFn ?? fsReadFileSync
  const path = opts.statePath
  if (!path) throw new Error('state-section: statePath is required')

  let raw1
  try {
    raw1 = readFn(path, 'utf8')
  } catch (err) {
    return { ok: false, retry: false, reason: `read-failed: ${err && err.message}` }
  }

  let next
  try {
    next = transform(raw1)
  } catch (err) {
    return { ok: false, retry: false, reason: err && err.message }
  }

  // re-read-before-write guard (T-9.1-40): a change since raw1 → abort, do not write.
  let raw2
  try {
    raw2 = readFn(path, 'utf8')
  } catch (err) {
    return { ok: false, retry: false, reason: `reread-failed: ${err && err.message}` }
  }
  if (raw2 !== raw1) {
    return { ok: false, retry: true, reason: 'concurrent-change: STATE.md changed between read and write' }
  }

  try {
    atomicWriteText(path, next, opts)
  } catch (err) {
    return { ok: false, retry: false, reason: `write-failed: ${err && err.message}` }
  }
  return { ok: true }
}

/** readSection(opts) → the raw region string between the fence markers. */
export function readSection(opts = {}) {
  const readFn = opts.readFn ?? fsReadFileSync
  if (!opts.statePath) throw new Error('state-section: statePath is required')
  return splitRegion(readFn(opts.statePath, 'utf8')).region
}

/** writeSection(region, opts) — splice `region` back between the markers (atomic + guarded). */
export function writeSection(region, opts = {}) {
  return mutate((raw) => {
    const { before, after } = splitRegion(raw)
    return before + region + after
  }, opts)
}

/** setPosition({phase, text}, opts) — OVERWRITE the Current Position body (snapshot rule). */
export function setPosition({ phase, text }, opts = {}) {
  return mutate((raw) => {
    const { before, region, after } = splitRegion(raw)
    return before + setPositionBody(region, phase, text) + after
  }, opts)
}

/** addBlocker({phase, text, kind}, opts) — append a parser-compatible blocker bullet. */
export function addBlocker({ phase, text, kind }, opts = {}) {
  return mutate((raw) => {
    const { before, region, after } = splitRegion(raw)
    return before + addBlockerBullet(region, phase, text, kind || 'tech') + after
  }, opts)
}

/** resolveBlocker({match}, opts) — remove exactly the bullet line containing `match`. */
export function resolveBlocker({ match }, opts = {}) {
  return mutate((raw) => {
    const { before, region, after } = splitRegion(raw)
    return before + resolveBlockerBullet(region, match) + after
  }, opts)
}

/** setSessions({name, owns}, opts) — APPEND one Active Sessions bullet (augment-not-clobber). */
export function setSessions({ name, owns }, opts = {}) {
  return mutate((raw) => {
    const { before, region, after } = splitRegion(raw)
    return before + addSessionBullet(region, name, owns || '') + after
  }, opts)
}
