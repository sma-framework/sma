/**
 * loader.mjs — the R4 read engine of pillar 1's layered memory.
 *
 * Resolves a task's tag set into CORE (always-load) + tag-matched periphery, with
 * a stable, repeatable ordering. This is what agents/sessions run AFTER the index
 * flip, to pull only the notes a task needs — the cure for the flat-index ceiling.
 *
 * AGENT PROTOCOL (summary; the full doc lands in the README + a memory note):
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
 * Exports (consumed by the CLI and the index flip):
 *   - resolvePeriphery({tags, corpusDir, tagsPath, dateMap}) → {core, periphery, matched, warnings, meta}
 *   - orderNotes(notes, dateMap) — the shared comparator applied to a note list.
 *
 * HYBRID DELIVERY, BY OPT-IN: a caller may hand `lexical` to resolvePeriphery, and the
 * periphery is then re-ranked and extended through the SHARED fusion (lexical-fusion.mjs
 * — the same one the pack compiler calls, so there is exactly one ordering rule in the
 * product). A caller that does not is byte for byte the caller it was: that is what
 * keeps a reflex, a pre-act injection and the control arm of a measurement on the strict
 * facet match they are built on. What the layer may add is intersected with the set the
 * hard filters cleared, and CORE is never re-ranked by it.
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
 * loadTagsRegistry + resolveAlias) — the single shared read path. The
 * ordering comparator, the corpus read and the CORE rule come from generator.mjs.
 * Node built-ins; zero deps.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { loadTagsRegistry, resolveAlias } from './frontmatter.mjs'
import { makeComparator, readNotes, isCoreNote, visibilityVerdict, untrustedVerdict, CORE_THRESHOLD } from './generator.mjs'
// The ONE place the layers of retrieval become one order (lexical-fusion.mjs). It is
// imported, never re-implemented: a second ordering rule here would be a second
// retrieval, and nobody downstream could tell which of the two answered them.
import { fuseLexical, FUSION_DEGRADED_REASON } from './lexical-fusion.mjs'

/**
 * SELECTION BASES — why a record that survived the hard filters is in the pack.
 *
 * Three different answers that a single word «selected» would collapse: the record
 * STATES it always loads, its number carried it over the CORE floor, or the task's
 * tags met its own. The fourth is the honest edge: a query that named no registered
 * facet constrains nothing, so nothing was excluded by matching — reporting that as
 * a tag hit would be claiming an intersection that never happened.
 *
 * Frozen and owned here, beside the code that decides, for the same reason the
 * filters own theirs (generator VISIBILITY_REASONS): one vocabulary, one place.
 */
export const SELECTION_BASES = Object.freeze({
  CORE: 'core',
  WEIGHT: 'weight',
  TAG: 'tag', // rendered as `tag:<name>` — the tag itself is part of the answer
  UNCONSTRAINED: 'unconstrained',
  NO_TAG_OVERLAP: 'no-tag-overlap',
})

/**
 * The query tags a note satisfies, sorted — DESCRIPTIVE only. The verdict stays
 * `noteMatches` (the real matcher); this names WHICH tags carried it, for a trace
 * that has to answer «on what grounds» rather than merely «yes». It is computed
 * only when a trace collector is attached, so the untraced path pays nothing.
 */
function matchedQueryTags(note, buckets, registry) {
  const resolvedTags = new Set((note.tags ?? []).map((t) => resolveAlias(t, registry)))
  const resolvedKind = resolveAlias(note.kind ?? '', registry)
  const out = []
  for (const facet of ['area', 'phase', 'topic']) {
    for (const q of buckets[facet]) if (resolvedTags.has(q)) out.push(q)
  }
  for (const q of buckets.kind) if (q === resolvedKind) out.push(q)
  return [...new Set(out)].sort()
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
 * @param {string|Date} [opts.now]       injected instant for the valid-time filter
 * @param {string} [opts.audience]       consumer class (default: the local owner)
 * @param {{repo?:string, environment?:string}} [opts.scope]  the world asking
 * @param {object} [opts.lexical]  OPTIONAL, and OPT-IN — the whole isolation of the
 *        hybrid delivery. ABSENT (every caller that does not name it, which is what a
 *        reflex, a pre-act injection and the control arm of a measurement all are) and
 *        this function does not ask the lexical layer a single question: not one branch
 *        below runs, and the answer is byte for byte the answer it always was. PRESENT
 *        — `{taskText, indexPath, layer}` — and the periphery is re-ranked and EXTENDED
 *        through the shared fusion: `taskText` is the words to search for, `indexPath`
 *        is where the derived index lives, `layer` is a stand-in for the lexical layer
 *        (tests; production passes none). Two things it may never do, both pinned by
 *        tests: CORE is not re-ranked by it, and an addition it brings must have
 *        cleared the SAME hard filters as everything else — a record the filters
 *        withheld cannot ride in on a lexical rank.
 * @param {Function|Array} [opts.trace]  OPTIONAL reason-trace collector (a callback or
 *        an array to push onto). Absent — the default — nothing is built and no event
 *        is shaped: the untraced load is the load it always was. Present: one event
 *        `{step, id, verdict, basis|reason, detail}` per record, so an explainer reads
 *        the decisions this function actually made instead of re-deriving them.
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
    trace,
    lexical,
  } = opts

  // The collector, normalized once: a callback, an array to push onto, or nothing.
  const emit = typeof trace === 'function' ? trace : Array.isArray(trace) ? (e) => trace.push(e) : null

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
  //
  // TWO VERDICTS, ONE CHAIN. `visibilityVerdict` answers «may this be SHOWN» from typed
  // structural fields and never from a body — that law is what makes it auditable, so
  // the question «may this be BELIEVED» is asked by its SIBLING right here,
  // inside the same filter, rather than as a fifth check that would retire the law, or
  // as a parallel filter in the compiler that would become a second read path.
  const visibility = { now, audience, scope }
  const refuse = (n) => {
    const denial = visibilityVerdict(n, visibility)
    if (denial) return denial
    return untrustedVerdict(n, visibility)
  }
  const notes = allNotes.filter((n) => {
    const denial = refuse(n)
    if (denial && emit) {
      const { reason, ...detail } = denial
      emit({ step: 'visibility', id: n.file, verdict: 'rejected', reason, detail })
    }
    return denial === null
  })

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

  // ── the reason trace, when somebody is collecting one ──────────────────────
  // Every record that CLEARED the hard filters leaves exactly one event here: the
  // grounds it was selected on, or the fact that the query's tags never met its own.
  // The verdicts are read off the sets this function already built — nothing is
  // re-decided for the trace, which is the only way an explanation can be trusted
  // to describe the selection instead of a plausible-looking parallel one.
  if (emit) {
    const peripherySet = new Set(peripheryFinal)
    const queried = buckets.area.size + buckets.kind.size + buckets.phase.size + buckets.topic.size
    for (const n of notes) {
      if (coreSet.has(n.file)) {
        const basis = n.contextPriority === 'always' ? SELECTION_BASES.CORE : SELECTION_BASES.WEIGHT
        emit({
          step: 'membership',
          id: n.file,
          verdict: 'selected',
          basis,
          detail: basis === SELECTION_BASES.CORE
            ? { field: 'context_priority', value: 'always' }
            : { field: 'importance', value: n.importance, threshold: coreThreshold },
        })
        continue
      }
      if (peripherySet.has(n.file)) {
        const hits = queried === 0 ? [] : matchedQueryTags(n, buckets, registry)
        emit({
          step: 'match',
          id: n.file,
          verdict: 'selected',
          basis: hits.length ? `${SELECTION_BASES.TAG}:${hits[0]}` : SELECTION_BASES.UNCONSTRAINED,
          detail: { tags: hits, query: [...buckets.area, ...buckets.kind, ...buckets.phase, ...buckets.topic].sort() },
        })
        continue
      }
      emit({
        step: 'match',
        id: n.file,
        verdict: 'rejected',
        reason: SELECTION_BASES.NO_TAG_OVERLAP,
        detail: { tags: n.tags ?? [], query: [...buckets.area, ...buckets.kind, ...buckets.phase, ...buckets.topic].sort() },
      })
    }
  }

  // ── the lexical layer, when — and ONLY when — a caller asked for it ────────
  // Everything above is the facet answer, unchanged. What happens here is a
  // RE-RANK-AND-EXTEND of the periphery: the fusion is handed the facet order it just
  // produced, and returns one order over that plus whatever the exact and lexical
  // layers found. Three properties are load-bearing and each has a test:
  //   - the additions are INTERSECTED with `notes`, the set the hard filters already
  //     cleared, so a withheld record cannot arrive by a lexical rank. The layer reads
  //     the corpus through the same visibility predicate, but «it should not happen»
  //     is not a guard; this is.
  //   - CORE is not touched. The frame of a pack is unconditional, and a rank is an
  //     argument about the on-demand half only.
  //   - a layer that cannot honestly run leaves the periphery EXACTLY as the facet
  //     path built it, and says why — in `meta` and in the caller-facing warnings.
  //     A silent fallback is the expensive failure: the delivery would then look
  //     hybrid and behave facet, and nobody would be able to tell from the outside.
  let peripheryOut = peripheryFinal
  let lexicalMeta = null
  if (lexical && typeof lexical === 'object') {
    const cleared = new Set(notes.map((n) => n.file))
    const areas = new Map(notes.map((n) => [n.file, Array.isArray(n.tags) ? n.tags : []]))
    const fusion = fuseLexical({
      taskText: String(lexical.taskText ?? tags.join(' ')),
      corpusDir,
      ...(now == null ? {} : { now }),
      ...(audience == null ? {} : { audience }),
      ...(scope == null ? {} : { scope }),
      ...(lexical.indexPath == null ? {} : { indexPath: lexical.indexPath }),
      ...(lexical.layer == null ? {} : { lexical: lexical.layer }),
      core: [...coreSet],
      periphery: peripheryFinal,
      areasOf: (f) => areas.get(f) ?? [],
      ...(emit == null ? {} : { emit }),
    })
    if (fusion && !fusion.degraded && Array.isArray(fusion.order)) {
      peripheryOut = fusion.order.filter((f) => cleared.has(f) && !coreSet.has(f))
      lexicalMeta = { degraded: false, added: peripheryOut.filter((f) => !new Set(peripheryFinal).has(f)).length }
    } else {
      lexicalMeta = { degraded: true, reason: FUSION_DEGRADED_REASON }
      warnings.push(
        `the lexical layer could not run (${FUSION_DEGRADED_REASON}) — the periphery below is the facet one; rebuild the memory index to restore hybrid delivery`,
      )
    }
  }

  const meta = {}
  if (peripheryOut.length === 0) meta.note = 'CORE only'
  if (lexicalMeta) meta.lexical = lexicalMeta

  const core = coreNotes.map((n) => n.file)

  // The on-demand discovery fallback — for every queried AREA
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

  // best-effort load-citation emission — one call per RETURNED
  // note (CORE + periphery), so every load is measured at the consumption
  // point. The callback is optional + injected (callers without it are byte-
  // identical in behavior) and each call is fail-open: a citation failure can
  // NEVER break the load it instruments (C9).
  if (typeof cite === 'function') {
    for (const f of [...core, ...peripheryOut]) {
      try {
        cite(f)
      } catch {
        /* fail-open — citations never break the load */
      }
    }
  }

  return {
    core,
    periphery: peripheryOut,
    matched: peripheryOut.length,
    indexFiles,
    warnings,
    meta,
  }
}
