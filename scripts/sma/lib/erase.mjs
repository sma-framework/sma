/**
 * erase.mjs — THE ONE DESTRUCTIVE EFFECT, and the only one in the memory layer.
 *
 * Every other lifecycle action TRANSITIONS a record: supersede, revoke, expire
 * and archive all leave the bytes on disk and change what the system is willing
 * to believe about them. This module removes the bytes. That difference is why
 * it is a module of its own rather than a fifth branch inside write-pipeline.mjs:
 * the pipeline's purity posture puts filesystem effects in named, single-purpose
 * functions, and destruction has earned a name.
 *
 * ONE LIST, WALKED TWICE. `ERASE_SURFACES` enumerates every place a copy of a
 * record's content can survive. `eraseRecord` clears that list and
 * `verifyErasure` walks the SAME list, so verification cannot drift from removal
 * — adding a derived index later means adding one entry, not remembering to
 * update two functions. A surface omitted from the list is a surface nobody will
 * ever check, which is the failure mode this shape exists to prevent.
 *
 * VERIFICATION READS THE DISK. Nothing here concludes a copy is gone because the
 * code that removed it returned without throwing. Each surface reports survivors
 * by reading itself back, and a surviving copy is a FAILURE naming the surface —
 * never a success with a warning attached.
 *
 * A PARTIAL ERASURE IS A FAILURE THAT STAYS INFORMATIVE. When one surface fails,
 * the result is `applied: false` and names it — and every surface that DID
 * succeed is still enumerated, because an operator told only "it failed" cannot
 * know what state the corpus is now in.
 *
 * DERIVED INDEXES ARE REBUILT, NEVER EDITED. `buildIndex`, `buildAreaIndexes`
 * and `buildLexicalIndex` regenerate from the canonical records — the law that
 * makes a derived index safe to delete in the first place. Hand-editing an index
 * line would make the index a second source of truth, which is exactly what the
 * law exists to prevent. A rebuild that no longer produces an area index file
 * DELETES the orphan: a builder that only writes would leave INDEX-<area>.md
 * holding the claim of the record that was its last member.
 *
 * THE JOURNAL IS EVIDENCE, NOT A COPY. The erasure is journalled through the
 * existing append-only journal and no prior entry is touched. The journal holds a
 * pointer and an event, never the content, so keeping it does not defeat the
 * deletion — and a deletion that erased the record of itself could not be
 * audited at all.
 *
 * GIT HISTORY IS NOT TOUCHED, AND THE RESULT SAYS SO. No code path in this module
 * executes a git command, and none ever should: automatic history rewriting is
 * irreversible and breaks every clone that already exists. It was rejected by
 * name (D-11-05). This module does everything it can honestly do and states the
 * one thing it cannot in its own result, rather than letting a caller assume.
 *
 * THE BUILD ANCHOR IS INJECTED, NOT DISCOVERED. Rebuilding the generated index
 * needs the commit it is stamped with, and reading that would mean running git.
 * So the caller passes `commitHash`/`dateMap`; with neither, the anchor already
 * on the existing index is inherited, and failing that the deterministic epoch is
 * used and the index is stamped honestly as unanchored.
 *
 * Node built-ins only; every filesystem read and removal goes through an
 * injectable `fsImpl`, so a failing surface can be exercised in a test. Zero deps.
 */

import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
} from 'node:fs'
import { join } from 'node:path'

import { appendEvent } from './journal.mjs'
import { atomicWriteRaw } from './fs-atomics.mjs'
import { parseNote } from './frontmatter.mjs'
import { buildAreaIndexes, buildIndex, GENERATED_MARKER } from './generator.mjs'
import { LEXICAL_ENGINES, LEXICAL_INDEX_FILE, buildLexicalIndex, metaPathFor, queryLexical } from './fts-index.mjs'
import { EPISODES_DIRNAME } from './episodes.mjs'
import { localStorePath } from './local-store.mjs'
import { resolveStorageClass } from './schema-v2.mjs'

/** The corpus subdirectory drafts live in — the same name write-pipeline.mjs uses. */
const DRAFTS_DIRNAME = 'drafts'

/** The generated always-load index file. */
const INDEX_FILENAME = 'MEMORY.md'

/** The per-area index files the generator produces. */
const AREA_INDEX_PATTERN = /^INDEX-.+\.md$/

/** The journal event type an erasure appends, so the evidence is greppable. */
export const ERASE_JOURNAL_EVENT_TYPE = 'memory-erase'

/** The terminal the journal is written under when the caller names none. */
const DEFAULT_TERMINAL = 'memory-erase'

/** The deterministic anchor for an index rebuilt with no commit to stamp it with. */
const EPOCH_COMMIT = '0000000'

/**
 * The one thing this operation cannot do, said in the refusal constant's own
 * honest register rather than left for a user to assume. It rides on every
 * result, successful or not.
 */
export const HISTORY_EXCEPTION =
  'git history is NOT touched, and this is the known exception rather than an oversight: a record that ' +
  'reached a commit is still in that commit and in every clone made since. Automatic history rewriting ' +
  'was rejected by decision — it is irreversible and it breaks every clone that already exists — so this ' +
  'operation does everything it can honestly do (the corpus, the working tree and every derived index, ' +
  'verified) and refuses to promise the rest. The way to never need it is the this-machine-only storage ' +
  'class, which keeps material out of git in the first place. See docs/MEMORY-THREAT-MODEL.md §6.4 for ' +
  'the manual route.'

/** The frontmatter fields that can hold a pointer AT another record. */
const LINK_FIELDS = Object.freeze(['derived_from', 'supersedes', 'superseded_by', 'predicted_from', 'excavated_from'])

/** The storage classes whose records live in the git-backed corpus. */
const CORPUS_CLASSES = Object.freeze(['shared', 'ephemeral'])

/** The storage class whose records live only in the local store. */
const LOCAL_CLASSES = Object.freeze(['this-machine-only'])

// ── the surfaces ─────────────────────────────────────────────────────────────

/**
 * ERASE_SURFACES — every place a copy of a record's content can survive.
 *
 * `kind: 'copy'` means the surface stores the record itself and the removal is a
 * deletion. `kind: 'derived'` means the surface is regenerated from the canonical
 * records and the removal is a REBUILD (plus the deletion of any artifact the
 * rebuild no longer produces).
 *
 * `stores` names the storage classes that route to a copy surface. It decides
 * what is CLEARED, never what is CHECKED: survivors are read back from every
 * surface on every call, because a copy found where the routing said it could not
 * be is precisely the case a class-filtered check would miss.
 */
export const ERASE_SURFACES = Object.freeze([
  Object.freeze({
    name: 'corpus',
    kind: 'copy',
    stores: CORPUS_CLASSES,
    describe: 'the active corpus — the reviewed record itself, in the git working tree',
  }),
  Object.freeze({
    name: 'drafts',
    kind: 'copy',
    stores: CORPUS_CLASSES,
    describe: 'the drafts area — a staged copy awaiting review, inside the same working tree',
  }),
  Object.freeze({
    name: 'local-store',
    kind: 'copy',
    stores: LOCAL_CLASSES,
    describe: 'the this-machine-only store — never in git, and still on this disk',
  }),
  Object.freeze({
    name: 'generated-index',
    kind: 'derived',
    stores: CORPUS_CLASSES,
    describe: 'the generated always-load index (MEMORY.md), which carries claim text on every CORE line',
  }),
  Object.freeze({
    name: 'area-indexes',
    kind: 'derived',
    stores: CORPUS_CLASSES,
    describe: 'the per-area catalogs (INDEX-<area>.md), one line of claim text per note',
  }),
  Object.freeze({
    name: 'lexical-index',
    kind: 'derived',
    stores: CORPUS_CLASSES,
    describe: 'the derived lexical index under .sma/, which answers queries from indexed axis text',
  }),
])

/** The surface descriptor by name — the list is the only registry. */
function surfaceNamed(name) {
  return ERASE_SURFACES.find((s) => s.name === name) ?? null
}

// ── the injectable filesystem ────────────────────────────────────────────────

/** The fs this module reads and removes through. Injectable for failure tests. */
function fsOf(input) {
  const impl = input && typeof input === 'object' && input.fsImpl && typeof input.fsImpl === 'object' ? input.fsImpl : {}
  return {
    existsSync: impl.existsSync ?? fsExistsSync,
    readFileSync: impl.readFileSync ?? fsReadFileSync,
    readdirSync: impl.readdirSync ?? fsReaddirSync,
    rmSync: impl.rmSync ?? fsRmSync,
    statSync: impl.statSync ?? fsStatSync,
  }
}

// ── the call context ─────────────────────────────────────────────────────────

/**
 * Resolve every directory ONCE, with the same defaulting posture the write
 * pipeline uses: a path is computed relative to the caller's root and nothing is
 * created here.
 */
function contextOf(input = {}) {
  const corpusDir = String(input.corpusDir ?? '')
  // A DESTRUCTIVE OPERATION NEVER INVENTS THE PATH OF A STORE IT WILL DELETE FROM.
  // Everywhere else in this codebase an unstated root defaults to the process's
  // cwd — a harmless posture for computing a path or reading one. Here it is not:
  // with a cwd default, an `eraseRecord` aimed at a temporary fixture corpus
  // would find the REAL installation's lexical index sitting at the relative
  // path and rebuild it from the fixture, silently destroying an artifact the
  // caller never named. The `.sma` stores are therefore opt-in: `repoRoot`,
  // `indexDir`, `localDir` or `dbPath` must be given, and a store nobody named
  // is reported `not-configured` rather than guessed at.
  const repoRoot = typeof input.repoRoot === 'string' && input.repoRoot.trim() ? input.repoRoot : null
  const indexDir = input.indexDir ?? (repoRoot ? join(repoRoot, '.sma', 'index') : null)
  return {
    id: String(input.id ?? '').trim(),
    corpusDir,
    draftsDir: input.draftsDir ?? join(corpusDir, DRAFTS_DIRNAME),
    episodesDir: input.episodesDir ?? join(corpusDir, EPISODES_DIRNAME),
    localDir: input.localDir ?? (repoRoot ? localStorePath({ repoRoot }) : null),
    dbPath: input.dbPath ?? (indexDir ? join(indexDir, LEXICAL_INDEX_FILE) : null),
    tagsPath: input.tagsPath ?? join(corpusDir, 'TAGS.md'),
    commitHash: input.commitHash ?? null,
    dateMap: input.dateMap && typeof input.dateMap === 'object' ? input.dateMap : {},
    now: input.now ?? undefined,
    journalDir: input.journalDir ?? undefined,
    terminalId: input.terminalId ?? DEFAULT_TERMINAL,
    by: input.by ?? null,
    reason: input.reason ?? null,
    fs: fsOf(input),
  }
}

/** The file a copy surface would hold for this id, or null when it has none. */
function copyPathOn(ctx, name) {
  if (ctx.id === '') return null
  if (name === 'corpus') return ctx.corpusDir ? join(ctx.corpusDir, `${ctx.id}.md`) : null
  if (name === 'drafts') return ctx.draftsDir ? join(ctx.draftsDir, `${ctx.id}.md`) : null
  if (name === 'local-store') return ctx.localDir ? join(ctx.localDir, `${ctx.id}.md`) : null
  return null
}

/**
 * Is this surface's location known? A store the caller never named is neither
 * cleared nor claimed clean — it is reported `not-configured`, so a caller that
 * forgot to name its local store learns that from the result instead of from a
 * copy nobody looked for.
 */
function surfaceConfigured(ctx, name) {
  if (name === 'corpus' || name === 'generated-index' || name === 'area-indexes') return ctx.corpusDir !== ''
  if (name === 'drafts') return Boolean(ctx.draftsDir)
  if (name === 'local-store') return Boolean(ctx.localDir)
  if (name === 'lexical-index') return Boolean(ctx.dbPath)
  return false
}

/** The reason a surface is unreachable, in the caller's own terms. */
const NOT_CONFIGURED_NOTE = Object.freeze({
  'local-store': 'no local store was named (pass localDir or repoRoot) — this surface was neither cleared nor verified, and a destructive operation does not guess the path of a store it would delete from',
  'lexical-index': 'no lexical index was named (pass dbPath, indexDir or repoRoot) — this surface was neither rebuilt nor verified, and rebuilding an index the caller never named could destroy an unrelated one',
})

/** Every INDEX-<area>.md that exists in the corpus right now. */
function areaIndexFiles(ctx) {
  try {
    return ctx.fs
      .readdirSync(ctx.corpusDir)
      .filter((f) => AREA_INDEX_PATTERN.test(f))
      .sort()
      .map((f) => join(ctx.corpusDir, f))
  } catch {
    return []
  }
}

/**
 * The commit the generated index is stamped with. INJECTED first; inherited from
 * the index already on disk second; the deterministic epoch last. Reading the
 * existing stamp is how the anchor is preserved without running git.
 */
function anchorOf(ctx) {
  if (typeof ctx.commitHash === 'string' && ctx.commitHash.trim() !== '') {
    return { commitHash: ctx.commitHash.trim(), dateMap: ctx.dateMap }
  }
  const prefix = GENERATED_MARKER.split('{commit}')[0]
  try {
    const head = ctx.fs.readFileSync(join(ctx.corpusDir, INDEX_FILENAME), 'utf8').split('\n')[0] ?? ''
    if (head.startsWith(prefix)) {
      const rest = head.slice(prefix.length).trim()
      const inherited = rest.split(/\s+/)[0] ?? ''
      if (inherited !== '') return { commitHash: inherited, dateMap: ctx.dateMap }
    }
  } catch {
    // no index to inherit from — fall through to the honest epoch
  }
  return { commitHash: EPOCH_COMMIT, dateMap: ctx.dateMap }
}

// ── survivors: what each surface still holds, read back from disk ────────────

/** Does a generated markdown artifact still name the record? */
function markdownHolds(ctx, path) {
  try {
    if (!ctx.fs.existsSync(path)) return false
    return ctx.fs.readFileSync(path, 'utf8').includes(`${ctx.id}.md`)
  } catch {
    return false
  }
}

/**
 * survivorsOn(ctx, name) -> {survivors, note}
 *
 * READS THE SURFACE. Never consults what a removal reported; that is the whole
 * point of having a separate function.
 */
function survivorsOn(ctx, name) {
  if (name === 'corpus' || name === 'drafts' || name === 'local-store') {
    const path = copyPathOn(ctx, name)
    if (!path) return { survivors: [], note: 'no path configured for this surface' }
    let present = false
    try {
      present = ctx.fs.existsSync(path)
    } catch {
      // an unreadable surface is not a clean one — say so rather than assume
      return { survivors: [path], note: 'the surface could not be read, so it cannot be called clean' }
    }
    return { survivors: present ? [path] : [], note: null }
  }

  if (name === 'generated-index') {
    const path = join(ctx.corpusDir, INDEX_FILENAME)
    if (!ctx.fs.existsSync(path)) return { survivors: [], note: 'no generated index on disk' }
    return { survivors: markdownHolds(ctx, path) ? [path] : [], note: null }
  }

  if (name === 'area-indexes') {
    const files = areaIndexFiles(ctx)
    if (files.length === 0) return { survivors: [], note: 'no per-area index files on disk' }
    return { survivors: files.filter((f) => markdownHolds(ctx, f)), note: null }
  }

  if (name === 'lexical-index') {
    if (!ctx.dbPath || !ctx.fs.existsSync(ctx.dbPath)) return { survivors: [], note: 'no lexical index on disk' }
    try {
      const answer = queryLexical({ query: ctx.id, dbPath: ctx.dbPath, limit: 200 })
      if (answer.engine === LEXICAL_ENGINES.UNAVAILABLE) {
        return { survivors: [], note: `the lexical engine is unavailable here — ${answer.reason}` }
      }
      const hit = (answer.results ?? []).some((r) => String(r.id) === `${ctx.id}.md`)
      return { survivors: hit ? [ctx.dbPath] : [], note: null }
    } catch (err) {
      return { survivors: [ctx.dbPath], note: `the lexical index could not be queried: ${String(err?.message ?? err)}` }
    }
  }

  return { survivors: [], note: 'unknown surface' }
}

// ── clearing: removal for a copy, a rebuild for a derived index ──────────────

/** Remove one file, honestly reporting whether it was there and whether it went. */
function removeFile(ctx, path) {
  if (!path) return { removed: [], error: null }
  let present = false
  try {
    present = ctx.fs.existsSync(path)
  } catch (err) {
    return { removed: [], error: `could not read ${path}: ${String(err?.message ?? err)}` }
  }
  if (!present) return { removed: [], error: null }
  try {
    ctx.fs.rmSync(path, { force: true })
  } catch (err) {
    return { removed: [], error: `could not remove ${path}: ${String(err?.message ?? err)}` }
  }
  return { removed: [path], error: null }
}

/**
 * clearSurface(ctx, name) -> {outcome, removed, rebuilt, error}
 *
 * `outcome` is one of: cleared · rebuilt · absent · failed.
 */
function clearSurface(ctx, name) {
  const empty = { removed: [], rebuilt: [], error: null }

  if (name === 'corpus' || name === 'drafts' || name === 'local-store') {
    const res = removeFile(ctx, copyPathOn(ctx, name))
    if (res.error) return { ...empty, outcome: 'failed', error: res.error }
    return { ...empty, outcome: res.removed.length ? 'cleared' : 'absent', removed: res.removed }
  }

  if (name === 'generated-index') {
    const path = join(ctx.corpusDir, INDEX_FILENAME)
    if (!ctx.fs.existsSync(path)) return { ...empty, outcome: 'absent' }
    try {
      const args = { corpusDir: ctx.corpusDir, tagsPath: ctx.tagsPath, ...anchorOf(ctx) }
      atomicWriteRaw(path, buildIndex(args))
      return { ...empty, outcome: 'rebuilt', rebuilt: [path] }
    } catch (err) {
      return { ...empty, outcome: 'failed', error: `the generated index could not be rebuilt: ${String(err?.message ?? err)}` }
    }
  }

  if (name === 'area-indexes') {
    const existing = areaIndexFiles(ctx)
    try {
      const args = { corpusDir: ctx.corpusDir, tagsPath: ctx.tagsPath, ...anchorOf(ctx) }
      const produced = buildAreaIndexes(args)
      if (existing.length === 0 && produced.length === 0) return { ...empty, outcome: 'absent' }
      const rebuilt = []
      const keep = new Set()
      for (const a of produced) {
        const path = join(ctx.corpusDir, a.file)
        keep.add(path)
        atomicWriteRaw(path, a.content)
        rebuilt.push(path)
      }
      // An area whose last member was just erased produces no file at all. A
      // builder that only writes would leave the orphan holding that member's
      // claim, which is the surviving-copy-on-a-derived-index failure exactly.
      const removed = []
      for (const path of existing) {
        if (keep.has(path)) continue
        const res = removeFile(ctx, path)
        if (res.error) return { ...empty, outcome: 'failed', rebuilt, error: res.error }
        removed.push(...res.removed)
      }
      return { removed, rebuilt, error: null, outcome: 'rebuilt' }
    } catch (err) {
      return { ...empty, outcome: 'failed', error: `the area indexes could not be rebuilt: ${String(err?.message ?? err)}` }
    }
  }

  if (name === 'lexical-index') {
    // No index on disk means no derived copy to clear. Building one HERE would
    // create an artifact the operator never asked for, on the one call where the
    // whole point is that something should stop existing.
    if (!ctx.dbPath || !ctx.fs.existsSync(ctx.dbPath)) return { ...empty, outcome: 'absent' }
    try {
      const built = buildLexicalIndex({ corpusDir: ctx.corpusDir, dbPath: ctx.dbPath, now: ctx.now })
      if (built.engine === LEXICAL_ENGINES.UNAVAILABLE) {
        return { ...empty, outcome: 'failed', error: `the lexical index could not be rebuilt: ${built.reason}` }
      }
      return { ...empty, outcome: 'rebuilt', rebuilt: [ctx.dbPath, metaPathFor(ctx.dbPath)] }
    } catch (err) {
      return { ...empty, outcome: 'failed', error: `the lexical index could not be rebuilt: ${String(err?.message ?? err)}` }
    }
  }

  return { ...empty, outcome: 'absent' }
}

// ── locating the record, and the class that routes it ────────────────────────

/** Read a record's frontmatter, or null when it is absent or unreadable. */
function frontmatterAt(ctx, path) {
  try {
    if (!path || !ctx.fs.existsSync(path)) return null
    const parsed = parseNote(ctx.fs.readFileSync(path, 'utf8'), { file: path })
    return parsed.frontmatter ?? null
  } catch {
    return null
  }
}

/**
 * Where the record actually is right now, in surface order. The FIRST copy found
 * supplies the frontmatter the storage class is resolved from.
 */
function locate(ctx) {
  const found = []
  let frontmatter = null
  for (const surface of ERASE_SURFACES) {
    if (surface.kind !== 'copy') continue
    const path = copyPathOn(ctx, surface.name)
    if (!path) continue
    let present = false
    try {
      present = ctx.fs.existsSync(path)
    } catch {
      present = false
    }
    if (!present) continue
    found.push({ surface: surface.name, path })
    if (frontmatter == null) frontmatter = frontmatterAt(ctx, path)
  }
  return { found, frontmatter }
}

/**
 * Which surfaces this erase CLEARS. Routing is by storage class — a shared record
 * has no copy in the local store and a this-machine-only record has none in the
 * corpus, and walking both would make every erase look half-broken.
 *
 * FAIL-CLOSED WIDENING: a surface where a copy was actually FOUND is cleared
 * whatever the class says. A restricted record that leaked into the corpus before
 * the placement gate existed must still be erasable; refusing to touch it because
 * the routing table says it cannot be there would leave the disclosure in place.
 */
function applicableSurfaces(ctx, storageClass, found) {
  const present = new Set(found.map((f) => f.surface))
  const inCorpusTree = present.has('corpus') || present.has('drafts')
  const names = new Set()
  for (const surface of ERASE_SURFACES) {
    if (surface.kind === 'copy') {
      if (present.has(surface.name) || surface.stores.includes(storageClass)) names.add(surface.name)
      continue
    }
    // A derived index is built from the corpus directory alone. It can only hold
    // the record when the record was in that directory.
    if (inCorpusTree || CORPUS_CLASSES.includes(storageClass)) names.add(surface.name)
  }
  return names
}

// ── links this operation did not author ──────────────────────────────────────

/** Every `.md` file in a directory, flat, or [] when the directory is absent. */
function markdownFilesIn(ctx, dir) {
  if (!dir) return []
  try {
    return ctx.fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => join(dir, f))
      .filter((p) => {
        try {
          return ctx.fs.statSync(p).isFile()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

/**
 * danglingLinks(ctx) -> [{file, where, field, value}]
 *
 * A record that still points at the erased one. It is REPORTED and left exactly
 * as it is: canon §13 item 2 forbids rewriting records this operation did not
 * author, and a pointer silently re-aimed is worse than one openly broken.
 */
function danglingLinks(ctx) {
  const out = []
  const places = [
    { where: 'corpus', dir: ctx.corpusDir },
    { where: 'drafts', dir: ctx.draftsDir },
    { where: 'episodes', dir: ctx.episodesDir },
  ]
  for (const place of places) {
    for (const path of markdownFilesIn(ctx, place.dir)) {
      const fm = frontmatterAt(ctx, path)
      if (fm == null) continue
      if (String(fm.id ?? '').trim() === ctx.id) continue
      for (const field of LINK_FIELDS) {
        const raw = fm[field]
        if (raw == null) continue
        const values = Array.isArray(raw) ? raw : [raw]
        for (const value of values) {
          const stem = String(value ?? '').trim().replace(/\.md$/i, '')
          if (stem !== ctx.id) continue
          out.push({ file: path, where: place.where, field, value: String(value) })
        }
      }
    }
  }
  return out
}

// ── the public boundary ──────────────────────────────────────────────────────

/**
 * verifyErasure({corpusDir, id, ...}) -> {id, clean, surfaces, survivors, history}
 *
 * Walks ERASE_SURFACES and reports, PER SURFACE, whether a copy survives — by
 * reading the surface, always. Never writes anything, never removes anything, and
 * is safe to call before an erase (where it reports what is there) as well as
 * after (where anything it finds is a failure).
 */
export function verifyErasure(input = {}) {
  const ctx = contextOf(input)
  const base = { id: ctx.id, clean: false, surfaces: [], survivors: [], history: historyNote() }

  if (ctx.id === '') {
    return { ...base, refusal: 'verifyErasure needs the id of the record it is verifying — an empty id names nothing' }
  }

  const surfaces = []
  const survivors = []
  const unverified = []
  for (const surface of ERASE_SURFACES) {
    if (!surfaceConfigured(ctx, surface.name)) {
      unverified.push(surface.name)
      surfaces.push({
        surface: surface.name,
        kind: surface.kind,
        describe: surface.describe,
        configured: false,
        survivors: [],
        note: NOT_CONFIGURED_NOTE[surface.name] ?? 'this surface has no configured location',
      })
      continue
    }
    const seen = survivorsOn(ctx, surface.name)
    surfaces.push({
      surface: surface.name,
      kind: surface.kind,
      describe: surface.describe,
      configured: true,
      survivors: seen.survivors,
      note: seen.note,
    })
    survivors.push(...seen.survivors)
  }

  return { ...base, clean: survivors.length === 0, surfaces, survivors, unverified }
}

/**
 * eraseRecord({corpusDir, id, ...}) -> the lifecycle result shape, plus what only
 * a destructive operation has to report.
 *
 * @returns {{applied:boolean, action:string, id:string, changed:string[],
 *            storage_class:string|null, surfaces:object[], failures:object[],
 *            dangling:object[], history:{touched:boolean, note:string},
 *            refusal?:string}}
 */
export function eraseRecord(input = {}) {
  const ctx = contextOf(input)
  const base = {
    applied: false,
    action: 'erase',
    id: ctx.id,
    changed: [],
    storage_class: null,
    surfaces: [],
    failures: [],
    unverified: [],
    dangling: [],
    history: historyNote(),
  }

  if (ctx.id === '') {
    return { ...base, refusal: 'erase needs the id of the record it removes — an empty id names nothing, and a destructive operation never guesses what a caller meant' }
  }
  if (ctx.corpusDir === '') {
    return { ...base, refusal: `erase "${ctx.id}": no corpusDir was given, and the surfaces a copy can live on are all resolved from it` }
  }

  const { found, frontmatter } = locate(ctx)
  if (found.length === 0) {
    const stale = verifyErasure(input)
    const where = stale.survivors.length ? ` (nothing to remove, but a derived index still names it: ${stale.survivors.join(', ')} — rebuild it with \`memory index rebuild\`)` : ''
    return { ...base, refusal: `no record "${ctx.id}" on any store this operation can reach${where}` }
  }

  const verdict = frontmatter == null ? null : resolveStorageClass(frontmatter)
  const storageClass = verdict && !verdict.refused ? verdict.storageClass : null
  const applicable = applicableSurfaces(ctx, storageClass, found)

  const surfaces = []
  const failures = []
  const changed = []
  const cleared = []

  const unverified = []
  for (const surface of ERASE_SURFACES) {
    if (!surfaceConfigured(ctx, surface.name)) {
      unverified.push(surface.name)
      surfaces.push({
        surface: surface.name,
        kind: surface.kind,
        describe: surface.describe,
        applicable: false,
        outcome: 'not-configured',
        removed: [],
        rebuilt: [],
        survivors: [],
        note: NOT_CONFIGURED_NOTE[surface.name] ?? 'this surface has no configured location',
      })
      continue
    }
    if (!applicable.has(surface.name)) {
      surfaces.push({
        surface: surface.name,
        kind: surface.kind,
        describe: surface.describe,
        applicable: false,
        outcome: 'not-applicable',
        removed: [],
        rebuilt: [],
        survivors: [],
        note: `the record's storage class is ${storageClass ?? 'unresolved'} — this surface does not hold it, so nothing was cleared here (it is still verified below)`,
      })
      continue
    }
    const res = clearSurface(ctx, surface.name)
    if (res.error) failures.push({ surface: surface.name, reason: res.error })
    changed.push(...res.removed, ...res.rebuilt)
    if (res.outcome === 'cleared' || res.outcome === 'rebuilt') cleared.push(surface.name)
    surfaces.push({
      surface: surface.name,
      kind: surface.kind,
      describe: surface.describe,
      applicable: true,
      outcome: res.outcome,
      removed: res.removed,
      rebuilt: res.rebuilt,
      survivors: [],
      note: res.error,
    })
  }

  // VERIFY BY READING, on every surface, applicable or not. A copy found where
  // the routing said it could not be is exactly the case a class-filtered check
  // would miss, and it is a failure like any other survivor.
  const verified = verifyErasure(input)
  for (const entry of surfaces) {
    const seen = verified.surfaces.find((s) => s.surface === entry.surface)
    if (!seen) continue
    entry.survivors = seen.survivors
    if (seen.note && !entry.note) entry.note = seen.note
    if (seen.survivors.length) {
      failures.push({
        surface: entry.surface,
        reason: `a copy of "${ctx.id}" survives on ${entry.surface}: ${seen.survivors.join(', ')}`,
      })
    }
  }

  const applied = failures.length === 0
  const dangling = danglingLinks(ctx)

  try {
    appendEvent(
      {
        type: ERASE_JOURNAL_EVENT_TYPE,
        scope: 'memory-corpus',
        detail: {
          stage: 'erase',
          action: 'erase',
          id: ctx.id,
          applied,
          storage_class: storageClass,
          surfaces: cleared,
          changed,
          failures: failures.map((f) => f.surface),
          unverified,
          dangling: dangling.length,
          by: ctx.by,
          reason: ctx.reason,
          history_touched: false,
        },
      },
      { terminalId: ctx.terminalId, journalDir: ctx.journalDir, now: ctx.now },
    )
  } catch {
    // fail-open on the journal ONLY: the removal already happened, and an
    // unwritable journal degrades the audit trail without un-deleting anything.
    // The result below still reports the truth of what was removed.
  }

  const result = { ...base, applied, storage_class: storageClass, changed, surfaces, failures, unverified, dangling }
  if (!applied) {
    result.refusal = `erase "${ctx.id}" did NOT complete: ${failures.map((f) => f.reason).join(' · ')}. The surfaces that were cleared are listed in \`surfaces\` — the corpus is in a partial state and the operation is not to be reported as done.`
  }
  return result
}

/** The history exception, as an object so a caller can branch on it. */
function historyNote() {
  return { touched: false, note: HISTORY_EXCEPTION }
}

/** Exported for the lifecycle branch — the one place that needs the descriptor list by name. */
export function eraseSurfaceNames() {
  return ERASE_SURFACES.map((s) => s.name)
}

export { surfaceNamed as __surfaceNamed }
