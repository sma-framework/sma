/**
 * episodes.mjs — the EPISODE layer: history, kept apart from doctrine.
 *
 * A reviewed memory record answers "what is true"; an EPISODE answers "what
 * happened". The two are different asset classes and this module exists to keep
 * them from being stored as one:
 *
 *   MULTI-CLAIM IS LEGAL HERE. The one-claim-per-record law that governs the
 *   reviewed corpus does not reach an episode: a night of work is one event and
 *   may carry a dozen assertions in its body. Nothing in this module asks for a
 *   `claim` field, and the record validator is deliberately NOT applied — an
 *   episode that had to be reduced to a single sentence to be storable would
 *   simply not be written down, which is the failure this layer prevents.
 *
 *   INVISIBLE BY DIRECTORY, NOT BY FILTER. Episodes live one level down, in
 *   `.claude/memory/episodes/`. Every corpus reader (generator.mjs, lint.mjs,
 *   loader.mjs) lists the corpus directory FLAT and keeps only regular `.md`
 *   files, so a subdirectory is skipped by construction. That is a stronger
 *   guarantee than an exclusion rule someone can forget to apply, and it is
 *   asserted directly: adding an episode produces byte-identical index output.
 *
 *   SAME SUBSTRATE. An episode is still a frontmatter'd markdown file in git —
 *   diffable, greppable, reviewable, and readable by the same parser. It is
 *   serialized EXCLUSIVELY through frontmatter.mjs (schema v2); there is no
 *   hand-rolled YAML in this file and there must never be.
 *
 * The link back: a reviewed claim extracted from an episode carries a scalar
 * `derived_from: <episode id>` — one claim, one origin, no arrays. `linkClaim`
 * is that law in code; it refuses to silently re-point a claim at a second
 * origin, because a claim whose provenance quietly moved is worse than one with
 * no provenance at all.
 *
 * Write discipline copied verbatim in spirit from memory-scaffold.mjs: every
 * write is guarded, nothing overwrites without an explicit `allowUpdate`, and
 * the return value reports honestly what happened. Node built-ins only.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteRaw } from './fs-atomics.mjs'
import { parseNote, serializeNote } from './frontmatter.mjs'
import { STATUS_VALUES, validateId } from './schema-v2.mjs'

/** The corpus subdirectory episodes live in — the single truth for every caller. */
export const EPISODES_DIRNAME = 'episodes'

/** The one memory type an episode may declare (docs/MEMORY-MODEL.md §2). */
export const EPISODE_MEMORY_TYPE = 'episodic'

/** The schema version episodes are written in. Episodes are v2-only by design. */
const EPISODE_SCHEMA_VERSION = '2'

/**
 * episodeArchiveFields — the MINIMAL schema-v2 field set an archived record
 * carries once it becomes an episode.
 *
 * Minimal is the point. An archived v1 note has no evidence array, no
 * fingerprint and no verification plan, and inventing them during an archival
 * pass would fabricate provenance. What an archive genuinely knows is: who it
 * is, what state it is in, which record replaced it, and when all of that was
 * true. That is this list, and nothing beyond it is required.
 *
 * Order is the field order of the archive contract; the ON-DISK emit order is
 * V2_KEY_ORDER's, owned by frontmatter.mjs.
 */
export const episodeArchiveFields = Object.freeze([
  'id',
  'schema_version',
  'memory_type',
  'status',
  'supersedes',
  'superseded_by',
  'superseded_at',
  'observed_at',
  'recorded_at',
  'valid_from',
  'valid_until',
  'sensitivity',
  'language',
])

/**
 * The subset of episodeArchiveFields an episode can never be written without.
 * The supersession pointers and the two open-ended dates (`observed_at` for an
 * event whose date is genuinely unknown, `valid_until` for one that has not
 * stopped being true) are "as applicable"; identity, lifecycle state, storage
 * class, language and the recording date are not.
 *
 * EXPORTED as `episodeRequiredFields` because the corpus lint holds episodes
 * already on disk to exactly this rule. A lint that re-derived "which fields are
 * really required" would be a second answer to a question this module already
 * answers at the write path — and the two would part company silently.
 */
export const episodeRequiredFields = Object.freeze([
  'status',
  'recorded_at',
  'sensitivity',
  'language',
])

/**
 * A legal episode id: the filename stem, and nothing that can leave the
 * directory. No separators, no leading dot, no whitespace — an id arriving from
 * a migration batch or a write pipeline is untrusted input on a filesystem
 * boundary, and `episodes/<id>.md` must resolve inside episodes/ or not at all.
 */
const EPISODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Assert an id is addressable and cannot escape the episodes directory. */
function assertEpisodeId(id, what) {
  const value = typeof id === 'string' ? id.trim() : ''
  if (value === '') {
    throw new Error(`${what}: an episode id is required (the id is the filename stem)`)
  }
  if (!EPISODE_ID_PATTERN.test(value)) {
    throw new Error(
      `${what}: "${value}" is not a legal episode id — letters, digits, dot, dash and underscore only, and it must address a file INSIDE ${EPISODES_DIRNAME}/`,
    )
  }
  return value
}

/** The episodes directory of a corpus. */
function episodesDirOf(corpusDir) {
  if (typeof corpusDir !== 'string' || corpusDir.trim() === '') {
    throw new Error('episodes: corpusDir is required (the .claude/memory directory)')
  }
  return join(corpusDir, EPISODES_DIRNAME)
}

/**
 * readEpisodes({corpusDir}) — every episode in the corpus, in name order.
 *
 * FAIL-SOFT on absence: a corpus with no episodes/ directory is a valid state
 * (a pre-migration install), and returns []. LOUD on anything else: a directory
 * that exists but cannot be read, or an episode whose record cannot be parsed,
 * throws with the file named. A history file that silently disappears from a
 * read is exactly the failure this layer exists to prevent.
 *
 * @param {{corpusDir: string}} args
 * @returns {Array<{file:string, id:string, frontmatter:object|null, body:string}>}
 */
export function readEpisodes({ corpusDir } = {}) {
  const dir = episodesDirOf(corpusDir)

  let entries
  try {
    entries = readdirSync(dir)
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }

  const out = []
  for (const file of entries.filter((f) => f.endsWith('.md')).sort()) {
    const path = join(dir, file)
    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }
    const text = readFileSync(path, 'utf8')
    const parsed = parseNote(text, { file })
    out.push({
      file,
      id: file.slice(0, -3),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    })
  }
  return out
}

/**
 * writeEpisode({corpusDir, id, frontmatter, body, allowUpdate}) — write one
 * episode, atomically, without ever clobbering by accident.
 *
 * The never-clobber posture is memory-scaffold.mjs's: an existing file is left
 * BYTE-FOR-BYTE alone unless the caller passes `allowUpdate: true`. The return
 * value distinguishes the three outcomes honestly, so a batch migration can
 * report what it actually did:
 *   {path, created: true,  written: true }  — the file did not exist
 *   {path, created: false, written: false}  — it existed and was left alone
 *   {path, created: false, written: true }  — it existed and was updated on request
 *
 * `id`, `schema_version` and `memory_type` are filled in from the id law and the
 * episode contract; every other archive field must be supplied. The record
 * validator is NOT run here: episodes are exempt from the one-claim law and
 * carry no `claim` at all (see the module header).
 *
 * @param {{corpusDir:string, id?:string, frontmatter?:object, body?:string, allowUpdate?:boolean}} args
 * @returns {{path:string, created:boolean, written:boolean}}
 */
export function writeEpisode({ corpusDir, id, frontmatter = {}, body = '', allowUpdate = false } = {}) {
  const dir = episodesDirOf(corpusDir)
  if (frontmatter == null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('writeEpisode: frontmatter must be an object')
  }

  const episodeId = assertEpisodeId(id ?? frontmatter.id, 'writeEpisode')
  const file = `${episodeId}.md`

  // The id law, through the schema's own validator — one truth for records and
  // episodes alike: the directory is irrelevant, only the stem counts.
  const idError = validateId(episodeId, file)
  if (idError) throw new Error(`writeEpisode: ${idError}`)
  if (frontmatter.id != null && String(frontmatter.id) !== episodeId) {
    throw new Error(
      `writeEpisode: id "${String(frontmatter.id)}" in the frontmatter disagrees with the target file "${file}" — the id law requires id === the filename stem`,
    )
  }

  const memoryType = frontmatter.memory_type == null ? EPISODE_MEMORY_TYPE : String(frontmatter.memory_type).trim()
  if (memoryType !== EPISODE_MEMORY_TYPE) {
    throw new Error(
      `writeEpisode: memory_type "${memoryType}" cannot be stored as an episode — an episode is "${EPISODE_MEMORY_TYPE}" by definition`,
    )
  }

  const schemaVersion = frontmatter.schema_version == null ? EPISODE_SCHEMA_VERSION : String(frontmatter.schema_version).trim()
  if (schemaVersion !== EPISODE_SCHEMA_VERSION) {
    throw new Error(
      `writeEpisode: schema_version "${schemaVersion}" is not writable as an episode — episodes are schema v${EPISODE_SCHEMA_VERSION} records`,
    )
  }

  const status = frontmatter.status == null ? '' : String(frontmatter.status).trim()
  if (status !== '' && !STATUS_VALUES.includes(status)) {
    throw new Error(
      `writeEpisode: status "${status}" is outside the closed vocabulary (${STATUS_VALUES.join(', ')})`,
    )
  }

  const record = {
    ...frontmatter,
    id: episodeId,
    schema_version: EPISODE_SCHEMA_VERSION,
    memory_type: EPISODE_MEMORY_TYPE,
  }

  const missing = episodeRequiredFields.filter(
    (f) => record[f] == null || String(record[f]).trim() === '',
  )
  if (missing.length) {
    throw new Error(
      `writeEpisode: episode "${episodeId}" is missing required archive field(s): ${missing.join(', ')}`,
    )
  }

  const path = join(dir, file)
  const existed = existsSync(path)
  if (existed && !allowUpdate) return { path, created: false, written: false }

  atomicWriteRaw(path, serializeNote({ frontmatter: record, body, schemaVersion: 2 }))
  return { path, created: !existed, written: true }
}

/**
 * linkClaim(frontmatter, episodeId) — stamp a reviewed claim with the episode it
 * was extracted from.
 *
 * `derived_from` is SCALAR: one claim comes from one episode. Returns a NEW
 * frontmatter object (the caller's is never mutated). Re-linking to the same
 * episode is a no-op; re-pointing at a different one throws, because a claim
 * whose provenance moved without anyone noticing is worse than one that never
 * claimed provenance at all.
 *
 * @param {object} frontmatter
 * @param {string} episodeId
 * @returns {object} a copy carrying derived_from
 */
export function linkClaim(frontmatter, episodeId) {
  if (frontmatter == null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('linkClaim: frontmatter must be an object')
  }
  const target = assertEpisodeId(episodeId, 'linkClaim')

  const existing = frontmatter.derived_from
  if (existing != null && String(existing).trim() !== '' && String(existing).trim() !== target) {
    throw new Error(
      `linkClaim: derived_from is already "${String(existing).trim()}" — a claim has ONE origin; re-pointing it at "${target}" would silently rewrite its provenance`,
    )
  }

  return { ...frontmatter, derived_from: target }
}
