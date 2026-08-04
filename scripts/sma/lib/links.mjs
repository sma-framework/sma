/**
 * links.mjs — the typed-link graph as a PROJECTION, never as a stored artifact.
 *
 * The corpus already carries its own edges: every record's `links` field holds
 * `{type, ref}` pairs from the closed vocabulary in schema-v2.mjs (docs/
 * MEMORY-MODEL.md §10). This module turns those fields into a graph value and
 * hands it back. It writes nothing, caches nothing and owns nothing — delete
 * anything this module ever returned and not one edge is lost, because the edges
 * live in the records.
 *
 * THAT IS THE WHOLE POINT, and it is the line between what was asked for and what
 * the canon forbids (§13 item 4: no graph engine, no graph database, no per-note
 * graph file). A projection that got persisted would immediately become a second
 * source of truth about the corpus, and the first time it drifted the corpus
 * would be the one that looked wrong.
 *
 * VALIDATION IS NOT RE-IMPLEMENTED HERE. `checkLinks` in schema-v2.mjs is the one
 * authority on what an edge may say; this module asks it and reports its refusals
 * in a named `refused` list. An edge whose `ref` names no record in the corpus is
 * reported in `dangling` and left out of the traversable graph — reported, not
 * repaired: rewriting a record this codebase did not author is exactly what canon
 * §13 item 2 forbids.
 *
 * DIRECTION AND SYMMETRY ARE NOT ENFORCED. An edge points from the record that
 * declares it to the record it names, and nothing here demands an inverse edge on
 * the other end. The one pair that IS symmetric — `supersedes`/`superseded_by` —
 * is written atomically as top-level fields by the write pipeline's
 * `applyLifecycle`, and that is where its symmetry is guaranteed.
 *
 * IDENTITY IS SOMEONE ELSE'S JOB. A record with no `id` is skipped: it has no
 * source key to hang an edge on. The id law belongs to `validateRecord`, and a
 * projection that invented an identity would be answering a question nobody asked
 * it.
 *
 * PURITY POSTURE (the same one write-pipeline.mjs states for itself): the
 * filesystem effect lives in ONE named function, `linkGraphFromCorpus`. Everything
 * else — `projectLinks` included — is a pure transform over already-parsed notes.
 * Node built-ins only; no dependency, and the fs is injectable for tests.
 */

import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseNote } from './frontmatter.mjs'
import { checkLinks } from './schema-v2.mjs'

/**
 * The shape of the value `projectLinks` returns, so a consumer can tell which
 * projection it is holding. Bumped when the returned shape changes, never when
 * the vocabulary widens — the vocabulary is LINK_TYPES' business.
 */
export const LINK_PROJECTION_VERSION = 'link-projection/1'

/**
 * projectLinks(notes) -> {version, edges, bySource, refused, dangling}
 *
 * The pure projection. `notes` may be parsed notes in `readCorpus`'s shape
 * (`{file, frontmatter, body}`) or bare frontmatter records; both are read the
 * same way, because callers on both sides of the write pipeline exist.
 *
 *   - `edges`     — every legal, resolvable edge as `{from, type, to}`, sorted by
 *                   source, then target, then type, so two runs are byte-comparable;
 *   - `bySource`  — the same edge objects grouped under their source id;
 *   - `refused`   — edges `checkLinks` would not accept, each with its reason;
 *   - `dangling`  — edges whose `ref` names no record in this corpus.
 *
 * Nothing is dropped in silence: an edge is in exactly one of the three lists.
 *
 * @param {Array<object>} notes
 * @returns {{version:string, edges:Array<object>, bySource:Record<string,Array<object>>, refused:Array<object>, dangling:Array<object>}}
 */
export function projectLinks(notes) {
  const records = normalizeNotes(notes)
  const known = new Set(records.map((r) => idOf(r)).filter((id) => id !== null))

  const edges = []
  const refused = []
  const dangling = []

  for (const record of records) {
    const from = idOf(record)
    if (from === null) continue

    const links = record.links
    if (links === null || links === undefined) continue

    // A `links` field that is not an array is one refusal about the field itself,
    // not a refusal per entry — there are no entries to walk.
    if (!Array.isArray(links)) {
      for (const reason of checkLinks(record)) refused.push({ from, index: null, type: null, ref: null, reason })
      continue
    }

    links.forEach((entry, index) => {
      const findings = checkLinks({ links: [entry] })
      if (findings.length > 0) {
        refused.push({
          from,
          index,
          type: readable(entry?.type),
          ref: readable(entry?.ref),
          reason: findings.map((f) => f.replace('links[0]', `links[${index}]`)).join(' · '),
        })
        return
      }
      const edge = { from, type: entry.type, to: entry.ref }
      if (!known.has(entry.ref)) dangling.push({ from, type: entry.type, ref: entry.ref })
      else edges.push(edge)
    })
  }

  edges.sort(by((e) => [e.from, e.to, e.type]))
  dangling.sort(by((d) => [d.from, d.ref, d.type]))
  refused.sort(by((r) => [r.from, String(r.index ?? -1).padStart(6, '0'), String(r.type ?? '')]))

  const bySource = {}
  for (const edge of edges) {
    if (!bySource[edge.from]) bySource[edge.from] = []
    bySource[edge.from].push(edge)
  }

  return { version: LINK_PROJECTION_VERSION, edges, bySource, refused, dangling }
}

/**
 * linkGraphFromCorpus({corpusDir, fsImpl}) -> the same value projectLinks would
 * return for the records in that directory.
 *
 * THE ONE FUNCTION HERE THAT TOUCHES THE FILESYSTEM, and it only reads. A file
 * the shared grammar cannot parse is skipped rather than fatal: one unreadable
 * neighbour must not take the whole graph down with it.
 *
 * @param {{corpusDir?:string, fsImpl?:object}} [args]
 * @returns {ReturnType<typeof projectLinks>}
 */
export function linkGraphFromCorpus(args = {}) {
  const { corpusDir, fsImpl } = args
  return projectLinks(readRecords(corpusDir, normalizeFs(fsImpl)))
}

// ── pure helpers ────────────────────────────────────────────────────────────

/** Read every parseable `.md` record in a directory. Never throws. */
function readRecords(dir, fs) {
  if (typeof dir !== 'string' || dir.trim() === '') return []
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of [...entries].map(String).sort()) {
    if (!name.endsWith('.md')) continue
    try {
      const note = parseNote(fs.readFileSync(join(dir, name), 'utf8'), { file: name })
      out.push(note.frontmatter ?? {})
    } catch {
      // unreadable neighbour or a grammar this parser does not know — skipped
    }
  }
  return out
}

/** Accept both `{file, frontmatter, body}` notes and bare frontmatter records. */
function normalizeNotes(notes) {
  if (!Array.isArray(notes)) return []
  const out = []
  for (const note of notes) {
    if (!isPlainObject(note)) continue
    out.push(isPlainObject(note.frontmatter) ? note.frontmatter : note)
  }
  return out
}

/** The record's own id, or null when it does not carry one. */
function idOf(record) {
  const id = record?.id
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

/** A value fit to appear in a refusal report without pretending it was a string. */
function readable(value) {
  return typeof value === 'string' ? value : value === undefined ? null : String(value)
}

/** Deterministic comparator over a tuple of string keys. */
function by(keyOf) {
  return (a, b) => {
    const ka = keyOf(a)
    const kb = keyOf(b)
    for (let i = 0; i < ka.length; i += 1) {
      const cmp = String(ka[i] ?? '').localeCompare(String(kb[i] ?? ''), 'en')
      if (cmp !== 0) return cmp
    }
    return 0
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize an injected fsImpl to the two functions this module needs. */
function normalizeFs(fsImpl) {
  return {
    readdirSync: (fsImpl && fsImpl.readdirSync) || fsReaddirSync,
    readFileSync: (fsImpl && fsImpl.readFileSync) || fsReadFileSync,
  }
}
