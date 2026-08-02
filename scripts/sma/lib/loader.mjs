/**
 * loader.mjs — the R4 read engine of pillar 1's layered memory.
 *
 * Resolves a task's tag set into CORE (always-load) + tag-matched periphery, with
 * a stable, repeatable ordering. This is what agents/sessions run AFTER the flip
 * (9-14) to pull only the notes a task needs — the cure for the flat-index ceiling.
 *
 * AGENT PROTOCOL (summary; the full doc lands in 9-14's README + a memory note):
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
 * Exports (consumed by the CLI 9-10, flip 9-14):
 *   - resolvePeriphery({tags, corpusDir, tagsPath, dateMap}) → {core, periphery, matched, warnings, meta}
 *   - orderNotes(notes, dateMap) — the shared comparator applied to a note list.
 *
 * TWO SCHEMA VERSIONS, ONE READ: the corpus may hold v1 notes and
 * schema-v2 records side by side. This module reads NEITHER grammar itself — the
 * corpus walk (generator.readNotes), the field projection (projectNoteAxis:
 * claim~description, memory_type~kind, retrieval.areas~tags, context_priority
 * 'always'~CORE) and the CORE membership question (isCoreNote, which keeps
 * superseded/revoked out of always-load) are all IMPORTED from generator.mjs.
 * That is deliberate: the loader used to re-derive tags/kind/importance from v1
 * field names, which made every migrated record invisible to both CORE and facet
 * matching while the written index showed it fine. One axis, one implementation —
 * do not re-introduce a local readNotes here.
 *
 * Corpus + registry access is ONLY through frontmatter.mjs (parseNote +
 * loadTagsRegistry + resolveAlias) — the single shared read path (9-04). The
 * ordering comparator, the corpus read and the CORE rule come from generator.mjs.
 * Node built-ins; zero deps.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loadTagsRegistry, resolveAlias } from './frontmatter.mjs'
import { makeComparator, readNotes, isCoreNote, isVisibleNow, CORE_THRESHOLD } from './generator.mjs'

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
 * @param {string|Date} [opts.now]       injected instant for the valid-time filter
 * @param {string} [opts.audience]       consumer class (default: the local owner)
 * @param {{repo?:string, environment?:string}} [opts.scope]  the world asking
 * @returns {{core:string[], periphery:string[], matched:number, indexFiles:string[], warnings:string[], meta:object}}
 */
export function resolvePeriphery(opts) {
  const {
    tags = [],
    corpusDir,
    tagsPath,
    dateMap = {},
    coreThreshold = CORE_THRESHOLD,
    cite,
    now,
    audience,
    scope,
  } = opts

  const registry = loadTagsRegistry(tagsPath)
  const allNotes = readNotes(corpusDir)
  const { buckets, warnings } = groupQueryByFacet(tags, registry)

  // HARD FILTERS FIRST (docs/MEMORY-MODEL.md §9.1): status, valid time, sensitivity
  // by audience and repo/environment scope are decided BEFORE anything is ranked,
  // matched or counted — so a record that may not be shown cannot win a comparison
  // it should never have entered. One chain, both output points below (CORE and
  // periphery) read `notes`, so there is no path around it. The predicate is the
  // generator's (isVisibleNow), the same module that owns CORE membership: one axis,
  // one implementation. A hidden record is out of DELIVERY, not out of the corpus —
  // the area indexes still catalogue it, because an index is a map, not a payload.
  const visibility = { now, audience, scope }
  const notes = allNotes.filter((n) => isVisibleNow(n, visibility))

  // CORE: always included first, ordered by the shared comparator. Membership is
  // the GENERATOR's question (isCoreNote), never re-derived here — so what loads
  // at read time is exactly what the index promised at write time, superseded and
  // revoked records excluded from always-load in both.
  const coreNotes = orderNotes(
    notes.filter((n) => isCoreNote(n, coreThreshold)),
    dateMap,
  )
  const coreSet = new Set(coreNotes.map((n) => n.file))

  // Periphery: everything CORE did not take that matches the facet intersection —
  // out of the notes the hard filters already cleared, so a retired or expired
  // record cannot ride in here after being kept out of CORE (it used to: the status
  // filter lived at CORE membership only, and the retrieval baseline caught exactly
  // that shape as a forbidden hit). It stays findable in its area index, with the
  // state named — out of delivery, not out of the corpus.
  // Dedup by file path AFTER resolution (a note matched via several tags loads once).
  const matched = notes.filter(
    (n) => !isCoreNote(n, coreThreshold) && noteMatches(n, buckets, registry),
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
