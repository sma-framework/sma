/**
 * reflex.mjs — the P2 reflex consumer core (49.1-10, B1/B2).
 *
 * The founder's hot-stove model: one burn (a promoted bug-lesson note),
 * permanent pre-act avoidance, inherited by every terminal. A PreToolUse hook
 * (`reflex-check` in cli.mjs) calls this module to match an impending
 * Edit/Write/Bash tool call against the `use-when` triggers of promoted
 * bug-lesson notes and inject an ADVISORY WARN via additionalContext.
 *
 * POSTURE (D-49.1-12, carried-forward lock): advisory WARN only —
 * permissionDecision is ALWAYS 'allow'; hard deny stays security-guard-only.
 * Soft-deny is 49.1-17's GATES tier, never a reflex.
 *
 * NO EMBEDDINGS in the match path (founder lock): matching is the existing
 * deterministic tag-facet loader (loader.resolvePeriphery) + an optional
 * `use-when-pattern` precision glob on notes. This module NEVER walks the
 * corpus directory itself — retrieval goes through loader.mjs only.
 *
 * CR-01 discipline (RESEARCH Pitfall 1): hooks deliver ABSOLUTE Windows paths;
 * deriveTags relativizes against the repo root BEFORE any matching, reusing
 * collision.mjs's normalizePath/relativizePath so there is ONE path truth.
 *
 * FATIGUE BATTERY (RESEARCH Pitfall 2 — launch-blocking, ships WITH the consumer):
 *   1. per-session dedup           — key = noteId + targetClass, seen-store
 *   2. explain-once-then-pointer   — first fire verbose/one-liner, later fires
 *                                    (new targetClass, same session) a pointer
 *   3. importance-tiered verbosity — >=8 verbose, 4-7 one-liner, <=3 silent
 *   4. session-scoped cooldown     — seen-store resets per session_id; a note
 *                                    goes silent after POINTER_CAP fires/session
 *   5. global kill-switch          — SMA_REFLEX_DISABLE env var
 *   6. per-note opt-out            — frontmatter `reflex: off`
 *
 * Everything is fail-open (C9): any internal error yields an empty result so a
 * hook can never wedge a session. Node built-ins only; dirs are DI-injectable.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizePath, relativizePath, compileGlob } from './collision.mjs'
import { parseNote, loadTagsRegistry, resolveAlias } from './frontmatter.mjs'
import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { REFLEX_DIR } from './constants.mjs'

/** Fires of ONE note per session before it goes silent (control 4, cooldown). */
export const POINTER_CAP = 3

/** Bash command-verb heuristics → operation tag candidates (plan Task 1 action). */
const BASH_CLASSES = [
  { tag: 'git', re: /(^|[\s;&|(])git\s/ },
  { tag: 'migration', re: /migrat/i },
  { tag: 'test', re: /\b(vitest|jest|playwright)\b|\b(pnpm|npm|yarn)\s+(run\s+)?test\b/ },
  { tag: 'install', re: /\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bpip\s+install\b|\bcargo\s+add\b/ },
]

/**
 * deriveTags(toolInput, root) → {tags, target, targetClass}.
 *
 * Edit/Write (`file_path`): relativize the ABSOLUTE hook path against the repo
 * root FIRST (CR-01), then emit each path segment (+ extension-stripped stem)
 * as a facet-tag candidate. targetClass = the directory portion — the dedup
 * granularity ("this class of file"), so two edits to the same module dedup.
 *
 * Bash (`command`): command-verb heuristics → operation tags; targetClass =
 * 'bash:<classes>'.
 *
 * Candidates are RAW here — matchReflexes filters them to registered
 * area-facet tags/aliases (precision guard: an unregistered segment must not
 * become an over-broad free-topic constraint or an unconstrained query).
 *
 * @param {{file_path?:string, command?:string}} toolInput
 * @param {string} root  repo root for relativization
 * @returns {{tags:string[], target:string, targetClass:string}}
 */
export function deriveTags(toolInput, root) {
  const empty = { tags: [], target: '', targetClass: '' }
  try {
    const input = toolInput || {}
    if (typeof input.file_path === 'string' && input.file_path.trim()) {
      const rootNorm = root ? normalizePath(root).replace(/\/+$/, '') + '/' : ''
      const target = relativizePath(normalizePath(input.file_path), rootNorm)
      const segments = target.split('/').filter(Boolean)
      const tags = []
      for (const seg of segments) {
        tags.push(seg)
        const stem = seg.replace(/\.[a-z0-9]+$/i, '')
        if (stem && stem !== seg) tags.push(stem)
      }
      const dir = segments.slice(0, -1).join('/')
      return { tags: [...new Set(tags)], target, targetClass: dir || target }
    }
    if (typeof input.command === 'string' && input.command.trim()) {
      const cmd = input.command
      const tags = []
      for (const { tag, re } of BASH_CLASSES) {
        if (re.test(cmd)) tags.push(tag)
      }
      const target = cmd.length > 200 ? cmd.slice(0, 200) : cmd
      return { tags, target, targetClass: 'bash:' + (tags.join('+') || 'other') }
    }
    return empty
  } catch {
    return empty // fail-open (C9)
  }
}

/**
 * matchReflexes({tags, target, corpusDir, tagsPath, loader}) → candidate notes.
 *
 * Retrieval goes through loader.resolvePeriphery ONLY (never duplicates tag
 * resolution; PATTERNS analog: exact). coreThreshold Infinity routes EVERY note
 * through facet matching (a CORE-importance bug-lesson must fire too — CORE is
 * otherwise returned unfiltered by kind/tags).
 *
 * Steps:
 *   1. Filter raw candidates to REGISTERED area tags/aliases (precision guard).
 *      Zero registered tags → zero candidates, never an all-bug-lessons query.
 *   2. Query = registered area tags + kind bug-lesson (AND across facets).
 *   3. Parse each matched note for use-when / use-when-pattern / importance /
 *      reflex opt-out / body (this is a targeted read of the matched files, not
 *      a corpus walk).
 *   4. `use-when-pattern` glob (compileGlob — the SAME subset collision.mjs
 *      uses), matched against the RELATIVIZED target path, narrows only.
 *
 * Fail-open: any error → []. Never throws.
 *
 * @param {{tags?:string[], target?:string, corpusDir:string, tagsPath:string, loader:{resolvePeriphery:Function}, dateMap?:object}} opts
 * @returns {Array<{noteId:string, file:string, importance:number, useWhen:string, description:string, reflexOptOut:boolean, body:string}>}
 */
export function matchReflexes(opts = {}) {
  try {
    const { tags = [], target = '', corpusDir, tagsPath, loader, dateMap = {} } = opts
    if (!loader || typeof loader.resolvePeriphery !== 'function') return []

    // (1) precision guard: only registered area tags/aliases survive.
    const registry = loadTagsRegistry(tagsPath)
    const registered = [
      ...new Set(tags.map((t) => resolveAlias(t, registry)).filter((t) => registry.area.has(t))),
    ]
    if (!registered.length) return []

    // (2) the ONLY retrieval entry point (no duplicate tag resolution).
    const res = loader.resolvePeriphery({
      tags: [...registered, 'bug-lesson'],
      corpusDir,
      tagsPath,
      dateMap,
      coreThreshold: Infinity,
    })
    const files = res && Array.isArray(res.periphery) ? res.periphery : []

    const out = []
    const targetNorm = normalizePath(target)
    for (const file of files) {
      let fm, body
      try {
        const parsed = parseNote(readFileSync(join(corpusDir, file), 'utf8'), { file })
        fm = parsed.frontmatter
        body = parsed.body
      } catch {
        continue // fail-soft per note
      }
      if (!fm || String(fm.kind ?? '').trim() !== 'bug-lesson') continue

      // (4) precision hint: narrows, never widens.
      const pattern =
        typeof fm['use-when-pattern'] === 'string' && fm['use-when-pattern'].trim()
          ? fm['use-when-pattern'].trim()
          : null
      if (pattern) {
        let hit = false
        try {
          hit = compileGlob(pattern).test(targetNorm)
        } catch {
          hit = false
        }
        if (!hit) continue
      }

      const importance = Number(fm.importance)
      out.push({
        noteId: file.replace(/\.md$/i, ''),
        file,
        importance: Number.isFinite(importance) ? importance : 0,
        useWhen: String(fm['use-when'] ?? ''),
        description: String(fm.description ?? ''),
        reflexOptOut: String(fm.reflex ?? '').trim().toLowerCase() === 'off',
        body: body ?? '',
      })
    }
    return out
  } catch {
    return [] // fail-open (C9)
  }
}

/**
 * applyFatigue({candidates, targetClass, sessionSeen, env}) → {warns, seen}.
 *
 * The full launch-blocking battery (module header, controls 1-6). Pure over its
 * inputs: mutates/extends the given seen-state and returns it; PERSISTENCE is
 * the caller's job via saveSeen (atomic write).
 *
 * seen shape: { session?: string, keys: {<noteId>::<targetClass>: count},
 *               notes: {<noteId>: fireCount} }
 *
 * @param {{candidates?:Array, targetClass?:string, sessionSeen?:object, env?:object}} opts
 * @returns {{warns:Array<{noteId:string, tier:string, text:string}>, seen:object}}
 */
export function applyFatigue(opts = {}) {
  const { candidates = [], targetClass = '', env = {} } = opts
  const seen = opts.sessionSeen && typeof opts.sessionSeen === 'object' ? opts.sessionSeen : {}
  if (!seen.keys || typeof seen.keys !== 'object') seen.keys = {}
  if (!seen.notes || typeof seen.notes !== 'object') seen.notes = {}

  try {
    // (5) global kill-switch.
    const disable = String(env.SMA_REFLEX_DISABLE ?? '').trim().toLowerCase()
    if (disable && disable !== '0' && disable !== 'false') return { warns: [], seen }

    const warns = []
    for (const c of candidates) {
      if (!c || !c.noteId) continue
      if (c.reflexOptOut) continue // (6) per-note opt-out

      const importance = Number(c.importance) || 0
      if (importance <= 3) continue // (3) silent tier

      // (1) per-session dedup: same note + same target class fires ONCE.
      const key = `${c.noteId}::${targetClass}`
      if (seen.keys[key]) {
        seen.keys[key] += 1
        continue
      }
      seen.keys[key] = 1

      // (4) session cooldown: a note goes silent after POINTER_CAP fires.
      const fires = (seen.notes[c.noteId] ?? 0) + 1
      seen.notes[c.noteId] = fires
      if (fires > POINTER_CAP) continue

      // (2)+(3) explain-once-then-pointer, importance-tiered verbosity.
      const tier = fires > 1 ? 'pointer' : importance >= 8 ? 'verbose' : 'oneliner'
      warns.push({ noteId: c.noteId, file: c.file, tier, text: formatWarn(c, tier) })
    }
    return { warns, seen }
  } catch {
    return { warns: [], seen } // fail-open (C9)
  }
}

/** Collapse a string to one whitespace-normalized line. */
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * extractHowToApply(body) — up to 3 lines from a "How to apply"/«Как применять»
 * section; falls back to the first 2 non-empty non-heading body lines.
 * @param {string} body
 * @returns {string[]}
 */
function extractHowToApply(body) {
  const lines = String(body ?? '').split('\n')
  const headIdx = lines.findIndex((l) =>
    /^#{1,6}\s*(how[\s-]*to[\s-]*apply|как применять)/i.test(l.trim()),
  )
  const picked = []
  if (headIdx !== -1) {
    for (let i = headIdx + 1; i < lines.length && picked.length < 3; i++) {
      const t = lines[i].trim()
      if (/^#{1,6}\s/.test(t)) break // next heading ends the section
      if (t) picked.push(t)
    }
  } else {
    for (const l of lines) {
      const t = l.trim()
      if (!t || /^#{1,6}\s/.test(t)) continue
      picked.push(t)
      if (picked.length >= 2) break
    }
  }
  return picked
}

/**
 * formatWarn(note, tier) → the WARN text (T-49.1-18: rule line + How-to-apply
 * extract + note id ONLY — never the full body).
 *
 * @param {{noteId?:string, file?:string, description?:string, useWhen?:string, body?:string}} note
 * @param {'verbose'|'oneliner'|'pointer'} tier
 * @returns {string}
 */
export function formatWarn(note, tier) {
  try {
    const id = note.noteId ?? String(note.file ?? '?').replace(/\.md$/i, '')
    if (tier === 'pointer') {
      return `SMA-рефлекс: см. заметку ${id} (правило уже показано в этой сессии)`
    }
    const rule = oneLine(note.description || note.useWhen || id)
    if (tier === 'oneliner') return `SMA-рефлекс [${id}]: ${rule}`
    const lines = [`SMA-рефлекс [${id}]: ${rule}`]
    const how = extractHowToApply(note.body)
    if (how.length) {
      lines.push(`  Как применять: ${how[0]}`)
      for (const l of how.slice(1)) lines.push(`  ${l}`)
    }
    lines.push(`  (заметка: .claude/memory/${note.file ?? id + '.md'})`)
    return lines.join('\n')
  } catch {
    return '' // fail-open (C9)
  }
}

/**
 * loadSeen({reflexDir, terminalId, sessionToken}) — read the per-terminal
 * seen-store. SESSION-SCOPED (control 4): a stored state from a DIFFERENT
 * session_id is discarded, so every new session starts fresh (never a
 * corpus-scoped mute). Missing/corrupt file → fresh state (fail-open).
 *
 * @param {{reflexDir?:string, terminalId?:string, sessionToken?:string|null}} opts
 * @returns {object}
 */
export function loadSeen(opts = {}) {
  const token = opts.sessionToken ?? null
  const fresh = token ? { session: token, keys: {}, notes: {} } : { keys: {}, notes: {} }
  try {
    const dir = opts.reflexDir ?? REFLEX_DIR
    const terminalId = opts.terminalId || 'unknown'
    const stored = readJsonSafe(join(dir, `${terminalId}-seen.json`))
    if (!stored || typeof stored !== 'object') return fresh
    if (token && stored.session !== token) return fresh // session reset
    return stored
  } catch {
    return fresh
  }
}

/**
 * saveSeen(seen, {reflexDir, terminalId}) — persist the seen-store atomically
 * (same-dir tmp + rename via fs-atomics; Windows-lock safe). Fail-open: a write
 * failure only costs dedup on the NEXT invocation, never the session.
 *
 * @param {object} seen
 * @param {{reflexDir?:string, terminalId?:string}} opts
 */
export function saveSeen(seen, opts = {}) {
  try {
    const dir = opts.reflexDir ?? REFLEX_DIR
    const terminalId = opts.terminalId || 'unknown'
    atomicWriteJson(join(dir, `${terminalId}-seen.json`), seen ?? {})
  } catch {
    /* fail-open (C9) */
  }
}
