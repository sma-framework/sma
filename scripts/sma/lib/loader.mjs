/**
 * loader.mjs — the R4 read engine of pillar 1's layered memory.
 *
 * Resolves a task's tag set into CORE (always-load) + tag-matched periphery, with
 * a stable, repeatable ordering. This is what agents/sessions run AFTER the flip
 * (49-14) to pull only the notes a task needs — the cure for the flat-index ceiling.
 *
 * AGENT PROTOCOL (summary; the full doc lands in 49-14's README + a memory note):
 *   A query is the set of facet tags describing the task at hand — one or more
 *   `area` tags, one or more `kind` tags, plus any free topic tags. The loader
 *   resolves aliases (B2), then intersects facets:
 *     - AND across facets: a note must satisfy EVERY queried facet.
 *     - OR within a facet:  within one facet, ANY of the queried tags matches.
 *   (B1 faceted intersection — «bug-lesson + parser» = kind bug-lesson AND the
 *   parser topic.) CORE is always returned first; zero periphery matches is a
 *   normal outcome (CORE only), never an error (C9).
 *
 * DETERMINISM (R4): ordering = importance desc → injected last-commit date desc →
 * name asc. Recency is NEVER the primary filter. The comparator is the SAME one
 * the generator writes with (imported from generator.mjs) — one ordering truth.
 *
 * Exports (consumed by the CLI 49-10, flip 49-14):
 *   - resolvePeriphery({tags, corpusDir, tagsPath, dateMap}) → {core, periphery, matched, warnings, meta}
 *   - orderNotes(notes, dateMap) — the shared comparator applied to a note list.
 *
 * Corpus + registry access is ONLY through frontmatter.mjs (parseNote +
 * loadTagsRegistry + resolveAlias) — the single shared read path (49-04). The
 * ordering comparator is imported from generator.mjs. Node built-ins; zero deps.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { parseNote, loadTagsRegistry, resolveAlias } from './frontmatter.mjs'
import { makeComparator, CORE_THRESHOLD } from './generator.mjs'

/** Structural files that are not notes. */
const STRUCTURAL_FILES = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])

/** The FI-11 per-area index files (INDEX-<area>.md) are structural, not notes. */
function isStructuralFile(f) {
  return STRUCTURAL_FILES.has(f) || /^INDEX-[^/\\]+\.md$/.test(f)
}

/** List note files (*.md, non-structural), sorted for a stable base order. */
function listNoteFiles(corpusDir) {
  let entries
  try {
    entries = readdirSync(corpusDir)
  } catch {
    return []
  }
  return entries
    .filter((f) => f.endsWith('.md') && !isStructuralFile(f))
    .filter((f) => {
      try {
        return statSync(join(corpusDir, f)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/** Read + parse every note (fail-soft: a bad note is skipped, not thrown). */
function readNotes(corpusDir) {
  const notes = []
  for (const file of listNoteFiles(corpusDir)) {
    let text
    try {
      text = readFileSync(join(corpusDir, file), 'utf8')
    } catch {
      continue
    }
    let fm
    try {
      fm = parseNote(text, { file }).frontmatter
    } catch {
      continue
    }
    if (fm == null) continue
    const importance = Number(fm.importance)
    notes.push({
      file,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      kind: String(fm.kind ?? '').trim(),
      importance: Number.isFinite(importance) ? importance : 0,
    })
  }
  return notes
}

/**
 * Group the resolved query tags into facet buckets using the registry.
 *   - a tag in registry.area   → the 'area' bucket
 *   - a tag in registry.kind   → the 'kind' bucket
 *   - phase:NN                  → the 'phase' bucket
 *   - anything else            → the 'topic' bucket (free topic tag; matched
 *                                against a note's raw tags, WARN noted in meta)
 * Aliases are resolved to canonical BEFORE bucketing (B2).
 */
function groupQueryByFacet(tags, registry) {
  const buckets = { area: new Set(), kind: new Set(), phase: new Set(), topic: new Set() }
  const warnings = []
  for (const raw of tags) {
    const tag = resolveAlias(raw, registry)
    if (registry.area.has(tag)) buckets.area.add(tag)
    else if (registry.kind.has(tag)) buckets.kind.add(tag)
    else if (/^phase:\d+$/.test(tag)) buckets.phase.add(tag)
    else {
      buckets.topic.add(tag)
      warnings.push(`query tag "${raw}" is not a registered area/kind facet — matched as a free topic tag`)
    }
  }
  return { buckets, warnings }
}

/**
 * A note matches the query iff, for EVERY queried facet that has any tags, the
 * note satisfies at least ONE of that facet's queried tags (AND across facets, OR
 * within — B1). A facet with no queried tags imposes no constraint.
 *
 * The `kind` facet is matched against the note's `kind` scalar (frontmatter field,
 * not the tags array); `area` / `phase` / free `topic` tags are matched against
 * the note's `tags` array. All comparisons are alias-resolved (B2) so a note
 * tagged with an alias still matches a canonical query and vice-versa.
 */
function noteMatches(note, buckets, registry) {
  const resolvedTags = new Set((note.tags ?? []).map((t) => resolveAlias(t, registry)))
  const resolvedKind = resolveAlias(note.kind ?? '', registry)

  // kind facet → the note's kind scalar.
  if (buckets.kind.size > 0 && !buckets.kind.has(resolvedKind)) return false

  // area / phase / topic facets → the note's tags array (OR within each facet).
  for (const facet of ['area', 'phase', 'topic']) {
    const queried = buckets[facet]
    if (queried.size === 0) continue
    let hit = false
    for (const q of queried) {
      if (resolvedTags.has(q)) {
        hit = true
        break
      }
    }
    if (!hit) return false // AND across facets
  }
  return true
}

/**
 * orderNotes(notes, dateMap) — apply the shared comparator (importance desc →
 * date desc → name asc) to a note list. The comparator is the SAME one the
 * generator writes the index with (one ordering truth; recency never primary).
 *
 * @param {Array<{file:string, importance:number}>} notes
 * @param {Record<string,string>} [dateMap]
 * @returns {Array<{file:string, importance:number}>}
 */
export function orderNotes(notes, dateMap = {}) {
  return notes.slice().sort(makeComparator(dateMap))
}

/**
 * resolvePeriphery(opts) — resolve a task's tag set into CORE + periphery.
 *
 * @param {object} opts
 * @param {string[]} opts.tags        the query tag set (aliases allowed)
 * @param {string} opts.corpusDir     directory of the memory notes
 * @param {string} opts.tagsPath      path to TAGS.md (the facet registry)
 * @param {Record<string,string>} [opts.dateMap]  file → last-commit ISO (injected)
 * @param {number} [opts.coreThreshold]  importance at/above which a note is CORE
 * @returns {{core:string[], periphery:string[], matched:number, indexFiles:string[], warnings:string[], meta:object}}
 */
export function resolvePeriphery(opts) {
  const { tags = [], corpusDir, tagsPath, dateMap = {}, coreThreshold = CORE_THRESHOLD, cite } = opts

  const registry = loadTagsRegistry(tagsPath)
  const notes = readNotes(corpusDir)
  const { buckets, warnings } = groupQueryByFacet(tags, registry)

  // CORE: always included first, ordered by the shared comparator.
  const coreNotes = orderNotes(
    notes.filter((n) => n.importance >= coreThreshold),
    dateMap,
  )
  const coreSet = new Set(coreNotes.map((n) => n.file))

  // Periphery: notes below the CORE threshold that match the facet intersection.
  // Dedup by file path AFTER resolution (a note matched via several tags loads once).
  const matched = notes.filter(
    (n) => n.importance < coreThreshold && noteMatches(n, buckets, registry),
  )
  const periphery = orderNotes(matched, dateMap).map((n) => n.file)
  // A CORE note is never repeated in periphery (threshold split already ensures it).
  const peripheryFinal = periphery.filter((f) => !coreSet.has(f))

  const meta = {}
  if (peripheryFinal.length === 0) meta.note = 'CORE only'

  const core = coreNotes.map((n) => n.file)

  // FI-11 (9.1-13): the on-demand discovery fallback — for every queried AREA
  // facet whose per-area index file exists, name it, so the caller can read
  // the full catalog line for a match (discovery line → INDEX file → note).
  const indexFiles = [...buckets.area]
    .sort()
    .map((a) => `INDEX-${a}.md`)
    .filter((f) => {
      try {
        return existsSync(join(corpusDir, f))
      } catch {
        return false
      }
    })

  // 9.1-11 (B4): best-effort load-citation emission — one call per RETURNED
  // note (CORE + periphery), so every load is measured at the consumption
  // point. The callback is optional + injected (callers without it are byte-
  // identical in behavior) and each call is fail-open: a citation failure can
  // NEVER break the load it instruments (C9).
  if (typeof cite === 'function') {
    for (const f of [...core, ...peripheryFinal]) {
      try {
        cite(f)
      } catch {
        /* fail-open — citations never break the load */
      }
    }
  }

  return {
    core,
    periphery: peripheryFinal,
    matched: peripheryFinal.length,
    indexFiles,
    warnings,
    meta,
  }
}
