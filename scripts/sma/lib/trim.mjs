/**
 * trim.mjs — the FI-9 demotion-only trimmer (9.1-13): the auto-repair for the
 * four size lints (MEM-CORESIZE / MEM-NOTESIZE / MEM-INDEXSIZE / STATE-SIZE).
 *
 * FOUNDER LOCK (FI-9, verbatim): «система никогда ничего не забывает» — overflow
 * moves DOWN a layer, it is NEVER deleted and NEVER time-decayed:
 *   - CORE overflow  → the least-recently-cited CORE members fall back to
 *     periphery (importance drops below the generator's CORE threshold — the
 *     SAME membership mechanism buildIndex reads, so the next regen agrees).
 *   - Note overflow  → the episodic tail splits into an archive note carrying a
 *     `supersedes` back-link to the source; combined content preserves every
 *     original line (post-condition asserted in code before any write).
 *   - STATE overflow → whole trailing sections move to STATE-ARCHIVE.md
 *     VERBATIM (byte-level containment); Current Position / Open Blockers /
 *     Active Sessions are protected and never move.
 *
 * STRUCTURALLY INCAPABLE OF DELETION: this module imports no file-removal API —
 * the plan's grep gate pins that. Every apply path stages a same-dir temp file
 * and renames it over the target via fs-atomics (Windows-safe).
 *
 * Demotion ORDER = least-recently-cited first (9.1-11's citation ledger via
 * citations.usageStats: never-cited notes demote before long-ago-cited ones,
 * and a recently-cited note is never selected while an uncited one exists) —
 * hot layers stay maximally useful per byte.
 *
 * Exports (consumed by the CLI `trim [--apply] [--json]` + lint's repair hint):
 *   - plan(opts)       — dry-run: {coreDemotions, noteSplits, stateOverflow}, zero writes
 *   - demoteCore(opts) — CORE → periphery demotion (dry by default; apply:true writes)
 *   - splitNote(opts)  — oversized note → trimmed note + archive note
 *   - trimState(opts)  — STATE.md overflow → STATE-ARCHIVE.md
 *
 * Node built-ins only; every dir/path is dependency-injectable.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { parseNote, serializeNote } from './frontmatter.mjs'
import { buildIndex, readNotes, renderCoreLine, CORE_THRESHOLD } from './generator.mjs'
import { usageStats } from './citations.mjs'
import { renameWithRetry } from './fs-atomics.mjs'
import { CORE_BUDGET, NOTE_BUDGET, STATE_BUDGET } from './constants.mjs'

/** The importance a demoted CORE member falls back to (just below membership). */
export const DEMOTED_IMPORTANCE = CORE_THRESHOLD - 1

/** UTF-8 byte length (budgets are BYTES, matching the lint checks). */
function byteLen(s) {
  return Buffer.byteLength(String(s ?? ''), 'utf8')
}

/**
 * Atomic raw-text write: same-dir `.tmp-` sibling + renameWithRetry over the
 * target (RESEARCH Pattern 4 — never the OS temp dir; Windows-lock retries).
 */
function atomicWriteText(targetPath, text) {
  const dir = dirname(targetPath)
  const tmpPath = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`)
  writeFileSync(tmpPath, text)
  renameWithRetry(tmpPath, targetPath)
}

/** Structural corpus files that are never notes (mirrors lint's predicate). */
function isStructuralFile(f) {
  return f === 'MEMORY.md' || f === 'ARCHIVE.md' || f === 'TAGS.md' || /^INDEX-[^/\\]+\.md$/.test(f)
}

/** List note files (*.md, non-structural), sorted (fail-soft). */
function listNoteFiles(corpusDir) {
  let entries
  try {
    entries = readdirSync(corpusDir)
  } catch {
    return []
  }
  return entries.filter((f) => f.endsWith('.md') && !isStructuralFile(f)).sort()
}

/** Extract the CORE section of a generated index (same shape lint measures). */
function extractCoreSection(indexText) {
  const lines = String(indexText ?? '').split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^## Ядро/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

// ── CORE demotion (least-recently-cited first) ────────────────────────────────

/**
 * Order CORE members for demotion: never-cited first (name asc among them),
 * then ascending lastCitedAt — the least-recently-cited demotes first, so a
 * recently-cited note is NEVER selected while an uncited one exists.
 */
function demotionOrder(coreNotes, lastCitedByNote) {
  return coreNotes.slice().sort((a, b) => {
    const ca = lastCitedByNote.get(a.file) ?? null
    const cb = lastCitedByNote.get(b.file) ?? null
    if ((ca == null) !== (cb == null)) return ca == null ? -1 : 1
    if (ca != null && cb != null && ca !== cb) return ca < cb ? -1 : 1
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  })
}

/**
 * Compute the CORE demotion list for an over-budget CORE section (pure read).
 * Sizing renders through generator.buildIndex + renderCoreLine — the exact
 * bytes the artifact would carry, so trim and regen agree by construction.
 *
 * @returns {Array<{file:string, lastCitedAt:string|null}>} least-recently-cited first
 */
function planCoreDemotions(opts) {
  const { corpusDir, tagsPath, usageDir, journalDir, dateMap = {}, coreBudget = CORE_BUDGET } = opts

  let coreNotes = []
  let coreBytes = 0
  try {
    const notes = readNotes(corpusDir)
    coreNotes = notes.filter((n) => n.importance >= CORE_THRESHOLD)
    if (!coreNotes.length) return []
    const index = buildIndex({ corpusDir, tagsPath, commitHash: '0000000', dateMap })
    coreBytes = byteLen(extractCoreSection(index))
  } catch {
    return [] // fail-soft: unreadable corpus/registry → nothing to propose
  }
  if (coreBytes <= coreBudget) return []

  const lastCitedByNote = new Map()
  try {
    for (const s of usageStats({ usageDir, journalDir }).notes) {
      lastCitedByNote.set(s.noteId, s.lastCitedAt)
    }
  } catch {
    /* fail-soft — no usage data: pure name-asc demotion order */
  }

  const ordered = demotionOrder(coreNotes, lastCitedByNote)
  const demotions = []
  let projected = coreBytes
  for (const n of ordered) {
    if (projected <= coreBudget) break
    projected -= byteLen(renderCoreLine(n) + '\n')
    demotions.push({ file: n.file, lastCitedAt: lastCitedByNote.get(n.file) ?? null })
  }
  return demotions
}

/**
 * Surgical importance edit: replace ONLY the `importance:` line inside the
 * frontmatter block, leaving every other byte of the note untouched. Returns
 * null when the note carries no importance line (never guesses).
 */
function setImportance(text, value) {
  if (!text.startsWith('---\n')) return null
  const closeIdx = text.indexOf('\n---\n', 3)
  if (closeIdx === -1) return null
  const block = text.slice(0, closeIdx)
  const m = /^importance:[^\n]*$/m.exec(block)
  if (!m) return null
  const updatedBlock = block.slice(0, m.index) + `importance: ${value}` + block.slice(m.index + m[0].length)
  return updatedBlock + text.slice(closeIdx)
}

/**
 * FI-9 post-condition: the demotion rewrite changed EXACTLY one line, and that
 * line is the importance field. Anything else → throw before the write.
 */
function assertOnlyImportanceChanged(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length !== b.length) {
    throw new Error('trim post-condition violated: demotion changed the line count of a note')
  }
  let diffs = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    diffs += 1
    if (!a[i].startsWith('importance:') || !b[i].startsWith('importance:')) {
      throw new Error(`trim post-condition violated: demotion touched a non-importance line ("${a[i]}")`)
    }
  }
  if (diffs !== 1) {
    throw new Error(`trim post-condition violated: demotion changed ${diffs} lines (expected exactly 1)`)
  }
}

/**
 * demoteCore(opts) — demote the least-recently-cited CORE members to periphery
 * until the CORE section fits its budget. Dry by default; apply:true performs
 * the surgical importance edits (atomic, post-condition-checked).
 *
 * @param {{corpusDir:string, tagsPath:string, usageDir?:string, journalDir?:string,
 *          dateMap?:object, coreBudget?:number, apply?:boolean}} opts
 * @returns {{demotions:Array, applied:boolean, demoted?:string[], skipped?:string[]}}
 */
export function demoteCore(opts = {}) {
  const demotions = planCoreDemotions(opts)
  if (opts.apply !== true) return { demotions, applied: false }

  const demoted = []
  const skipped = []
  for (const d of demotions) {
    const path = join(opts.corpusDir, d.file)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      skipped.push(d.file)
      continue
    }
    const updated = setImportance(text, DEMOTED_IMPORTANCE)
    if (updated == null) {
      skipped.push(d.file) // no importance line — never guess, never rewrite
      continue
    }
    assertOnlyImportanceChanged(text, updated) // FI-9: content preserved or no write
    atomicWriteText(path, updated)
    demoted.push(d.file)
  }
  return { demotions, applied: true, demoted, skipped }
}

// ── Note splitting (episodic tail → archive note) ─────────────────────────────

/**
 * splitNote(opts) — split an over-budget note: the head stays in place (with a
 * pointer wikilink), the tail moves VERBATIM into `<stem>_archive.md` carrying
 * a `supersedes` back-link to the source (FI-9 + bi-temporal P3 shape).
 * Dry by default; apply:true writes archive FIRST, then the trimmed note — a
 * failure between the two duplicates content, never loses it.
 *
 * @param {{corpusDir:string, file:string, budget?:number, apply?:boolean}} opts
 * @returns {{split:boolean, file:string, reason?:string, archiveFile?:string,
 *            applied?:boolean, keptLines?:number, movedLines?:number}}
 */
export function splitNote(opts = {}) {
  const { corpusDir, file, budget = NOTE_BUDGET } = opts
  const path = join(corpusDir, file)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { split: false, file, reason: 'unreadable' }
  }
  if (byteLen(text) <= budget) return { split: false, file, reason: 'within budget' }

  let parsed
  try {
    parsed = parseNote(text, { file })
  } catch {
    return { split: false, file, reason: 'unparseable frontmatter — fix the note first (MEM-SCHEMA)' }
  }
  if (parsed.frontmatter == null) return { split: false, file, reason: 'no frontmatter' }

  const closeIdx = text.indexOf('\n---\n', 3)
  const head = text.slice(0, closeIdx + 5) // the frontmatter block, byte-verbatim
  const stem = file.replace(/\.md$/, '')
  const archiveFile = `${stem}_archive.md`
  if (existsSync(join(corpusDir, archiveFile))) {
    return { split: false, file, reason: `archive note ${archiveFile} already exists` }
  }

  const pointer = `\n> Продолжение: [[${stem}_archive]] — эпизодический хвост вынесен \`sma trim\` (FI-9: ничего не удалено).\n`
  const bodyLines = parsed.body.split('\n')
  const kept = []
  let i = 0
  for (; i < bodyLines.length; i++) {
    const candidate = head + [...kept, bodyLines[i]].join('\n') + pointer
    if (byteLen(candidate) > budget) break
    kept.push(bodyLines[i])
  }
  const tail = bodyLines.slice(i)
  if (!tail.some((l) => l.trim() !== '')) return { split: false, file, reason: 'nothing to move' }

  const trimmedText = head + kept.join('\n') + pointer
  const fm = parsed.frontmatter
  const archiveText = serializeNote({
    frontmatter: {
      description: `Архивный хвост заметки ${file}, вынесен командой sma trim (FI-9)`,
      kind: String(fm.kind ?? 'episodic') || 'episodic',
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      'use-when': `при обращении к полной истории ${stem}`,
      importance: 2,
      supersedes: file, // the FI-9 back-link to the source note
    },
    body: tail.join('\n') + (tail.length && tail[tail.length - 1] !== '' ? '\n' : ''),
  })

  // FI-9 post-condition BEFORE any write: every original body line survives
  // in the combined (trimmed + archive) content.
  const combined = new Set([...trimmedText.split('\n'), ...archiveText.split('\n')])
  for (const line of bodyLines) {
    if (line.trim() === '') continue
    if (!combined.has(line)) {
      throw new Error(`trim post-condition violated: line would be lost by splitNote(${file}): "${line.slice(0, 80)}"`)
    }
  }

  if (opts.apply !== true) {
    return { split: true, file, archiveFile, applied: false, keptLines: kept.length, movedLines: tail.length }
  }
  atomicWriteText(join(corpusDir, archiveFile), archiveText) // archive FIRST
  atomicWriteText(path, trimmedText)
  return { split: true, file, archiveFile, applied: true, keptLines: kept.length, movedLines: tail.length }
}

// ── STATE.md trimming (overflow sections → STATE-ARCHIVE.md) ──────────────────

/** Headings that must never leave STATE.md (the board parser's anchors). */
const PROTECTED_STATE_HEADINGS = /current position|open blockers|active sessions/i

/** Static banner between archive appends (deterministic — no clock). */
const STATE_ARCHIVE_BANNER = '\n<!-- sma trim: перенесено из STATE.md (FI-9: ничего не удалено) -->\n'

/**
 * trimState(opts) — move whole trailing `## ` sections of an over-budget
 * STATE.md into STATE-ARCHIVE.md VERBATIM (last section first) until the
 * snapshot fits its budget. Protected sections (Current Position / Open
 * Blockers / Active Sessions) and the preamble never move. Dry by default;
 * apply:true appends to the archive FIRST, then rewrites STATE.md.
 *
 * @param {{statePath:string, archivePath?:string, budget?:number, apply?:boolean}} opts
 * @returns {{trimmed:boolean, reason?:string, bytes?:number, projectedBytes?:number,
 *            movedSections?:string[], movedChunks?:string[], archivePath?:string, applied?:boolean}}
 */
export function trimState(opts = {}) {
  const { statePath, budget = STATE_BUDGET } = opts
  let text
  try {
    text = readFileSync(statePath, 'utf8')
  } catch {
    return { trimmed: false, reason: 'unreadable' }
  }
  const bytes = byteLen(text)
  if (bytes <= budget) return { trimmed: false, reason: 'within budget', bytes }

  const archivePath = opts.archivePath ?? join(dirname(statePath), 'STATE-ARCHIVE.md')

  // Chunk the file: preamble + one chunk per `## ` section. Chunks are built
  // by joining the SAME '\n'-split lines, so each chunk is a verbatim
  // substring of the original text (byte-level containment holds).
  const lines = text.split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i])) starts.push(i)
  }
  if (!starts.length) return { trimmed: false, reason: 'no sections to move', bytes }

  const chunks = [] // {heading, text, movable}
  const preamble = lines.slice(0, starts[0]).join('\n')
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length
    const heading = lines[from].replace(/^##\s*/, '').trim()
    chunks.push({
      heading,
      text: lines.slice(from, to).join('\n'),
      movable: !PROTECTED_STATE_HEADINGS.test(heading),
    })
  }

  // Move from the END backwards until the projected size fits.
  const keep = chunks.map(() => true)
  const moved = []
  let projected = bytes
  for (let s = chunks.length - 1; s >= 0 && projected > budget; s--) {
    if (!chunks[s].movable) continue
    keep[s] = false
    moved.unshift(chunks[s]) // archive preserves original order
    projected -= byteLen(chunks[s].text) + 1 // + the joining newline
  }
  if (!moved.length) return { trimmed: false, reason: 'only protected sections', bytes }

  const remaining = [preamble, ...chunks.filter((_, s) => keep[s]).map((c) => c.text)]
    .filter((part) => part !== '')
    .join('\n')

  const result = {
    trimmed: true,
    bytes,
    projectedBytes: byteLen(remaining),
    movedSections: moved.map((c) => c.heading),
    movedChunks: moved.map((c) => c.text),
    archivePath,
    applied: false,
  }
  if (opts.apply !== true) return result

  // Archive FIRST (append semantics), then the trimmed snapshot — a failure
  // in between duplicates content, never loses it (FI-9-safe write order).
  let archiveText = ''
  try {
    archiveText = readFileSync(archivePath, 'utf8')
  } catch {
    archiveText = '# STATE-ARCHIVE — вынесенные из STATE.md секции (sma trim)\n'
  }
  atomicWriteText(archivePath, archiveText + STATE_ARCHIVE_BANNER + moved.map((c) => c.text).join('\n') + '\n')
  atomicWriteText(statePath, remaining)
  return { ...result, applied: true }
}

// ── the plan() entrypoint (dry-run aggregate) ─────────────────────────────────

/**
 * plan(opts) — the pure dry-run over every trim surface: what WOULD demote,
 * split, and move. ZERO writes (Test 1 pins byte-identical trees).
 *
 * @param {{corpusDir:string, tagsPath?:string, usageDir?:string, journalDir?:string,
 *          statePath?:string, dateMap?:object}} opts
 * @returns {{coreDemotions:Array, noteSplits:Array, stateOverflow:object|null}}
 */
export function plan(opts = {}) {
  const corpusDir = opts.corpusDir
  const tagsPath = opts.tagsPath ?? (corpusDir ? join(corpusDir, 'TAGS.md') : null)

  const coreDemotions = planCoreDemotions({ ...opts, tagsPath })

  const noteSplits = []
  for (const f of listNoteFiles(corpusDir)) {
    let bytes
    try {
      bytes = byteLen(readFileSync(join(corpusDir, f), 'utf8'))
    } catch {
      continue
    }
    if (bytes > NOTE_BUDGET) noteSplits.push({ file: f, bytes })
  }

  let stateOverflow = null
  if (typeof opts.statePath === 'string' && opts.statePath.trim() !== '') {
    const r = trimState({ statePath: opts.statePath, archivePath: opts.archivePath, apply: false })
    if (r.trimmed) {
      stateOverflow = { bytes: r.bytes, projectedBytes: r.projectedBytes, sections: r.movedSections }
    }
  }

  return { coreDemotions, noteSplits, stateOverflow }
}
