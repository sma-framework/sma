/**
 * fts-index.mjs — the LEXICAL layer of retrieval, built in canon order and built
 * EXPERIMENTAL: an exact path/symbol match first, a derived SQLite index second, and
 * neither of them in the default delivery path until a measured comparison says they
 * earn their place.
 *
 * WHY A PROBE AND NOT A DEPENDENCY. The canon names «SQLite FTS/BM25 as a derived
 * index», and the platform seems to hand it over for free: `node:sqlite` is standard
 * library, zero packages, zero servers. It is not free. The module exists only from
 * Node 22.5, and — the part that is easy to miss — the OFFICIAL Node build compiles
 * SQLite WITHOUT the full-text extension (nodejs/node#56951, open). On the machine
 * this was written on the extension happens to be there, which is exactly the
 * condition under which «works for me» becomes a silent regression on somebody else's
 * laptop. So the layer never assumes: it PROBES, and it carries a deterministic BM25
 * fallback over ordinary tables — same storage engine, no extension — so the answer
 * is the same shape whichever build it lands on. Where the module is absent entirely,
 * the layer reports itself unavailable and returns; a missing capability is not an
 * exception, and the deterministic facet/exact layers keep working underneath it.
 *
 * WHY THE INDEX MAY BE DELETED AT ANY MOMENT. It is a DERIVED artifact under `.sma/`
 * (gitignored, never committed), rebuilt in full from the corpus by one command. The
 * law it obeys is the oldest one here: if an index cannot be reconstructed from the
 * canonical records, it has quietly become a source of truth. Staleness is therefore
 * a CONTENT hash of the projected corpus, not a byte-diff of the database file —
 * SQLite files are not byte-deterministic even for identical data, and comparing them
 * would report drift that does not exist.
 *
 * ONE READ PATH. Everything here — the exact layer and the index build alike — sees
 * the corpus through `projectNoteAxis` with `isVisibleNow` applied, the same
 * projection and the same read-time filters the loader itself uses. A retriever with
 * its own idea of what a note is, or of which notes may be shown, is a second read
 * path, and second read paths diverge silently. The consumer's read-time filter still
 * stands ON TOP of this one: an index that is the only thing standing between a
 * withheld record and a payload is one bug away from disclosing it.
 *
 * THE INDEXED TEXT IS THE AXIS, NOT THE FILE. What gets indexed is what the axis
 * carries — the claim, the use-when trigger, the path facet, the areas, the kind and
 * the note's own name. The bodies are deliberately not read: retrieval today decides
 * on the axis, and reaching past it here would be that second read path in its most
 * tempting form. It follows honestly that a body-only edit does not make the index
 * stale, because it did not change anything the index contains.
 *
 * PURE over its inputs and injectable throughout: the SQLite module, the probe and
 * the instant all arrive as options, so both absences can be tested on a machine
 * where neither is real. Node built-ins only; zero deps, zero LLM, zero network.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { isVisibleNow, projectNoteAxis, readNotes } from './generator.mjs'

const require_ = createRequire(import.meta.url)

/**
 * The three states the layer can honestly be in. `unavailable` is not a failure mode
 * to be smoothed over — it is the answer on a machine whose Node predates the module,
 * and it must be as reportable as the other two.
 */
export const LEXICAL_ENGINES = Object.freeze({
  FTS5: 'fts5',
  FALLBACK: 'fallback-bm25',
  UNAVAILABLE: 'unavailable',
})

/** The bases the exact layer can select on — named, because «matched» is not a reason. */
export const EXACT_BASES = Object.freeze({ PATH: 'path', SYMBOL: 'symbol' })

// ─────────────────────────── capability ──────────────────────────────────────

/**
 * probeFts5(DatabaseSync) — does THIS build carry the full-text extension.
 *
 * The only trustworthy way to ask is to try: a version check answers a different
 * question (which Node), and the compile flag is not exposed anywhere else. The probe
 * runs in `:memory:` so it touches no file, and closes the handle on both paths —
 * a probe that leaks a handle every call is a probe nobody will run at startup.
 *
 * @param {Function} DatabaseSync  the constructor from node:sqlite (injectable)
 * @returns {boolean}
 */
export function probeFts5(DatabaseSync) {
  let db
  try {
    db = new DatabaseSync(':memory:')
  } catch {
    return false
  }
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(body)')
    return true
  } catch {
    return false
  } finally {
    try {
      db.close()
    } catch {
      /* a handle that refuses to close does not change the answer */
    }
  }
}

/** The real module load, isolated so the «no module at all» branch is testable. */
function defaultLoadSqlite() {
  return require_('node:sqlite')
}

/**
 * lexicalCapability(opts) → {module, fts5, engine, reason}
 *
 * Asked once and passed down. `reason` is filled ONLY when something is missing, and
 * it names what — a layer that reports «unavailable» without saying why sends its
 * owner reading source code to learn they are on Node 20.
 *
 * @param {{loadSqlite?:Function, probe?:Function}} [opts]
 */
export function lexicalCapability(opts = {}) {
  const { loadSqlite = defaultLoadSqlite, probe = probeFts5 } = opts
  let mod
  try {
    mod = loadSqlite()
  } catch (err) {
    return {
      module: false,
      fts5: false,
      engine: LEXICAL_ENGINES.UNAVAILABLE,
      reason: `модуль node:sqlite недоступен (нужен Node ≥22.5): ${err && err.message ? err.message : err}`,
    }
  }
  const DatabaseSync = mod && mod.DatabaseSync
  if (typeof DatabaseSync !== 'function') {
    return {
      module: false,
      fts5: false,
      engine: LEXICAL_ENGINES.UNAVAILABLE,
      reason: 'модуль node:sqlite загрузился без DatabaseSync — сборка не поддерживает встроенный SQLite',
    }
  }
  let fts5 = false
  try {
    fts5 = probe(DatabaseSync) === true
  } catch {
    fts5 = false
  }
  return {
    module: true,
    fts5,
    engine: fts5 ? LEXICAL_ENGINES.FTS5 : LEXICAL_ENGINES.FALLBACK,
    reason: fts5 ? '' : 'сборка node:sqlite без расширения FTS5 — работает детерминированный BM25-фолбэк',
    DatabaseSync,
  }
}

// ─────────────────────────── the shared corpus read ──────────────────────────

/**
 * A record as the ONE axis sees it. A caller handing in raw frontmatter gets it
 * projected through `projectNoteAxis` rather than read field by field here: a second
 * reading of the same frontmatter is a second answer waiting to drift.
 */
function axisOf(note) {
  const n = note ?? {}
  if (typeof n === 'object' && 'pathPattern' in n && 'weight' in n) return n
  return projectNoteAxis(n, { file: n.file ?? '' })
}

/**
 * The visible corpus, read once. `notes` may be injected (tests, or a caller that has
 * already read); either way the read-time filters run here, so no path into this
 * module can see a record the loader would have withheld.
 */
function visibleCorpus(opts = {}) {
  const { notes, corpusDir, now, audience, scope } = opts
  const all = (Array.isArray(notes) ? notes : corpusDir ? readNotes(corpusDir) : []).map(axisOf)
  const visibility = { ...(now == null ? {} : { now }), ...(audience == null ? {} : { audience }), ...(scope == null ? {} : { scope }) }
  const visible = all.filter((n) => isVisibleNow(n, visibility))
  return { all, visible }
}

// ─────────────────────────── tokenisation ────────────────────────────────────

/**
 * Words, by the Unicode letter/number classes the corpus generator already normalises
 * with (`\p{L}\p{N}`) — never a split on spaces. The corpus is bilingual: a naive
 * `\w+` drops Cyrillic entirely, and a lexical layer that cannot see half its corpus
 * fails the exact class of case the benchmark tests by name.
 */
export function lexicalTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== '')
}

/** Trim the punctuation a token collects from prose, keeping path and symbol chars. */
function trimToken(raw) {
  return String(raw ?? '').replace(/^[^\p{L}\p{N}_$/\\.*]+/u, '').replace(/[^\p{L}\p{N}_$/\\.*]+$/u, '')
}

/** A path token: it carries a separator, which prose words do not. */
function isPathToken(t) {
  return t.includes('/') || t.includes('\\')
}

/**
 * A symbol token: an identifier SHAPE, not merely a word. `compilePack` and
 * `valid_until` are symbols; «corpus» and «record» are prose, and an exact layer that
 * matched prose would be a bad lexical layer wearing an exact layer's name.
 */
function isSymbolToken(t) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) return false
  return t.includes('_') || t.includes('$') || /[a-z][A-Z]/.test(t) || /[A-Za-z][0-9]/.test(t)
}

/** Path comparison form: one separator, one case. Paths are not case-sensitive here. */
function normalizePath(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').toLowerCase()
}

/**
 * A declared path facet may be a glob (the corpus writes precision globs). Translated
 * literally: `**` spans separators, `*` and `?` do not. Everything else is escaped —
 * a facet is data, never a pattern language the note's author can smuggle logic into.
 */
function globToRegExp(pattern) {
  let out = ''
  const p = normalizePath(pattern)
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        out += '.*'
        i += 1
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

// ─────────────────────────── layer 1: exact path/symbol ──────────────────────

/**
 * queryExact(opts) — the FIRST layer in canon order: a deterministic match on typed
 * facets, no index, no ranking model, nothing probabilistic to fall back from.
 *
 * Two ways in, and both are exact:
 *   - PATH   — a path-shaped token of the task equals (or is matched by) the path
 *              facet the record declares. Case-insensitive and separator-agnostic,
 *              because a path typed by a human on Windows is the same path.
 *   - SYMBOL — an identifier-shaped token of the task appears verbatim among the
 *              identifiers of the record's claim or trigger. Case-SENSITIVE: in code
 *              `Note` and `note` are two things, and folding them would be a guess.
 *
 * @param {object} opts
 * @param {string} opts.query        the task text
 * @param {object[]} [opts.notes]    projected records (default: read from corpusDir)
 * @param {string} [opts.corpusDir]
 * @param {string|Date} [opts.now]   INJECTED instant for the read-time filters
 * @param {string} [opts.audience]
 * @param {{repo?:string, environment?:string}} [opts.scope]
 * @param {number} [opts.limit]
 * @returns {{metric:string, query:string, results:object[], summary:object}}
 */
export function queryExact(opts = {}) {
  const { query, limit } = opts
  const text = String(query ?? '')
  const { all, visible } = visibleCorpus(opts)

  const raw = text.split(/\s+/).map(trimToken).filter((t) => t !== '')
  const pathTokens = [...new Set(raw.filter(isPathToken).map(normalizePath))]
  const symbolTokens = [...new Set(raw.filter(isSymbolToken))]

  const results = []
  for (const note of visible) {
    const facet = note.pathPattern ?? ''
    if (facet) {
      const declared = normalizePath(facet)
      const rx = declared.includes('*') || declared.includes('?') ? globToRegExp(declared) : null
      const hit = pathTokens.find((t) => (rx ? rx.test(t) : t === declared))
      if (hit != null) {
        results.push({ id: note.file, basis: EXACT_BASES.PATH, field: 'retrieval.paths', matched: hit, declared })
        continue // one record, one reason: the path is the stronger of the two
      }
    }
    if (symbolTokens.length) {
      const symbols = new Set(
        `${note.description ?? ''} ${note.hint ?? ''} ${note.useWhen ?? ''}`
          .split(/[^A-Za-z0-9_$]+/)
          .filter(isSymbolToken),
      )
      const hit = symbolTokens.find((t) => symbols.has(t))
      if (hit != null) results.push({ id: note.file, basis: EXACT_BASES.SYMBOL, field: 'claim', matched: hit, declared: hit })
    }
  }

  // path before symbol, then by name: a total order, so two runs cannot disagree
  const rank = { [EXACT_BASES.PATH]: 0, [EXACT_BASES.SYMBOL]: 1 }
  results.sort((a, b) => rank[a.basis] - rank[b.basis] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const cut = Number.isFinite(Number(limit)) && Number(limit) > 0 ? results.slice(0, Number(limit)) : results

  return {
    metric: 'memory-exact',
    query: text,
    results: cut,
    summary: {
      corpus_notes: all.length,
      visible_notes: visible.length,
      path_tokens: pathTokens.length,
      symbol_tokens: symbolTokens.length,
      matched: cut.length,
    },
  }
}

// ─────────────────────────── layer 2: the derived index ──────────────────────

/** The default home of the derived index: under `.sma/`, which git never sees. */
export const LEXICAL_INDEX_FILE = 'memory-lexical.sqlite'

/** The meta file beside it — engine, corpus hash, build instant. */
export function metaPathFor(dbPath) {
  return String(dbPath ?? '').replace(/\.sqlite$/i, '') + '.meta.json'
}

/**
 * The text of a record as the index sees it: the axis, nothing else (see the module
 * header on why the body stays unread).
 */
export function indexableDocument(note) {
  const n = axisOf(note)
  const areas = Array.isArray(n.tags) ? n.tags.join(' ') : ''
  return [n.file, n.description, n.useWhen, n.hint, n.pathPattern, areas, n.kind].filter((p) => p != null && p !== '').join(' \n ')
}

/**
 * corpusHash(notes) — the staleness key: a hash of WHAT WAS INDEXED, not of the file
 * that holds it. Two builds of an unchanged corpus produce the same hash; two SQLite
 * files of the same data do not produce the same bytes.
 */
export function corpusHash(notes) {
  const h = createHash('sha256')
  for (const note of [...notes].map(axisOf).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    h.update(note.file ?? '')
    h.update('\u0000')
    h.update(indexableDocument(note))
    h.update('\u0000')
  }
  return h.digest('hex')
}

/**
 * The storage layout the index is written with. It travels in the meta file so an
 * index built by an older layout is STALE rather than silently misread — a schema
 * change is exactly the kind of drift that otherwise shows up as wrong answers.
 */
export const LEXICAL_SCHEMA_VERSION = 1

/** BM25's two knobs, at the values the literature and SQLite's own bm25() use. */
const BM25_K1 = 1.2
const BM25_B = 0.75

/** How many ranked rows a query returns unless the caller says otherwise. */
const DEFAULT_LIMIT = 20

/** The meta file, or null when it is absent or unreadable — never a throw. */
function readMeta(dbPath) {
  if (!dbPath) return null
  try {
    const parsed = JSON.parse(readFileSync(metaPathFor(dbPath), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Open the index for reading only. A query has no business writing to a derived
 * artifact, and saying so to the engine is cheaper than trusting every code path
 * downstream to remember. Older builds that do not know the option still open.
 */
function openRead(DatabaseSync, dbPath) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return new DatabaseSync(dbPath)
  }
}

/**
 * buildLexicalIndex(opts) — rebuild the derived index from the corpus, IN FULL.
 *
 * Full, not incremental, and that is the point: the file is deleted and written
 * again from the projected corpus, so there is no state in it that the corpus cannot
 * account for. Both engines store the SAME token stream (our tokeniser, not the
 * engine's), so a machine with the full-text extension and a machine without it index
 * the same words — otherwise the fallback would quietly answer a different question.
 *
 * Returns an honest `unavailable` report where the module is missing.
 *
 * @param {object} opts
 * @param {string} opts.dbPath        where the derived index lives (under .sma/)
 * @param {string} [opts.corpusDir]
 * @param {object[]} [opts.notes]     projected records (default: read from corpusDir)
 * @param {string|Date} [opts.now]    INJECTED build instant
 * @param {Function} [opts.loadSqlite] module loader double
 * @param {Function} [opts.probe]     capability probe double
 */
export function buildLexicalIndex(opts = {}) {
  const { dbPath, now } = opts
  const capability = lexicalCapability(opts)
  const { visible, all } = visibleCorpus(opts)

  if (capability.engine === LEXICAL_ENGINES.UNAVAILABLE) {
    return {
      metric: 'memory-lexical-index',
      engine: LEXICAL_ENGINES.UNAVAILABLE,
      reason: capability.reason,
      db_path: dbPath ?? null,
      meta_path: dbPath ? metaPathFor(dbPath) : null,
      corpus_hash: null,
      built_at: null,
      indexed: 0,
      corpus_notes: all.length,
      visible_notes: visible.length,
    }
  }

  if (!dbPath) throw new TypeError('buildLexicalIndex: нужен dbPath — производный индекс живёт в .sma/, путь задаёт вызывающий')

  const engine = capability.engine
  const builtAt = now == null ? new Date().toISOString() : now instanceof Date ? now.toISOString() : String(now)
  const documents = visible.map((n) => {
    const tokens = lexicalTokens(indexableDocument(n))
    return { id: n.file, tokens, body: tokens.join(' ') }
  })
  const hash = corpusHash(visible)

  mkdirSync(dirname(dbPath), { recursive: true })
  // a rebuild is a REBUILD: nothing of the previous file survives into this one
  for (const path of [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(path, { force: true })

  const db = new capability.DatabaseSync(dbPath)
  try {
    if (engine === LEXICAL_ENGINES.FTS5) {
      db.exec("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, body, tokenize = 'unicode61')")
      const insert = db.prepare('INSERT INTO docs (id, body) VALUES (?, ?)')
      for (const doc of documents) insert.run(doc.id, doc.body)
    } else {
      // the same index, spelled out by hand: which documents exist and how long they
      // are, and which term occurs how often in which document. Nothing here needs an
      // extension to be compiled in, which is the whole reason it exists.
      db.exec('CREATE TABLE docs (id TEXT PRIMARY KEY, len INTEGER NOT NULL)')
      db.exec('CREATE TABLE postings (term TEXT NOT NULL, id TEXT NOT NULL, tf INTEGER NOT NULL)')
      db.exec('CREATE INDEX postings_term ON postings (term)')
      const insertDoc = db.prepare('INSERT INTO docs (id, len) VALUES (?, ?)')
      const insertPosting = db.prepare('INSERT INTO postings (term, id, tf) VALUES (?, ?, ?)')
      for (const doc of documents) {
        insertDoc.run(doc.id, doc.tokens.length)
        const frequency = new Map()
        for (const term of doc.tokens) frequency.set(term, (frequency.get(term) ?? 0) + 1)
        for (const [term, tf] of [...frequency.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) insertPosting.run(term, doc.id, tf)
      }
    }
  } finally {
    db.close()
  }

  const meta = {
    engine,
    schema: LEXICAL_SCHEMA_VERSION,
    corpus_hash: hash,
    built_at: builtAt,
    indexed: documents.length,
    corpus_notes: all.length,
    visible_notes: visible.length,
  }
  writeFileSync(metaPathFor(dbPath), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  return {
    metric: 'memory-lexical-index',
    engine,
    reason: capability.reason,
    db_path: dbPath,
    meta_path: metaPathFor(dbPath),
    corpus_hash: hash,
    built_at: builtAt,
    indexed: documents.length,
    corpus_notes: all.length,
    visible_notes: visible.length,
  }
}

/**
 * queryLexical(opts) — the ranked lexical answer, or an honest empty one.
 *
 * THE TASK TEXT IS DATA, NEVER SQL. The statement is fixed and every value is bound;
 * the full-text expression is assembled from OUR tokens, which are letters and digits
 * by construction, so a task text carrying quotes, MATCH operators or a semicolon is
 * a handful of harmless words by the time it reaches the engine. On the fallback the
 * question is only ever «which documents hold this term», one bound parameter at a
 * time, and BM25 is arithmetic in this process.
 *
 * Scores are returned so that HIGHER IS BETTER on both engines — SQLite's bm25()
 * returns a negative number where a smaller value is a better match, and handing two
 * opposite conventions to a caller is how a fusion layer silently ranks backwards.
 */
export function queryLexical(opts = {}) {
  const { query, dbPath, limit = DEFAULT_LIMIT } = opts
  const capability = lexicalCapability(opts)
  const terms = [...new Set(lexicalTokens(query))]

  if (capability.engine === LEXICAL_ENGINES.UNAVAILABLE) {
    return { metric: 'memory-lexical', engine: LEXICAL_ENGINES.UNAVAILABLE, reason: capability.reason, terms: [], results: [] }
  }

  const meta = readMeta(dbPath)
  if (meta == null || !dbPath || !existsSync(dbPath)) {
    return {
      metric: 'memory-lexical',
      engine: capability.engine,
      reason: 'индекс не построен — `sma memory index rebuild`',
      terms,
      results: [],
    }
  }
  const engine = meta.engine === LEXICAL_ENGINES.FTS5 ? LEXICAL_ENGINES.FTS5 : LEXICAL_ENGINES.FALLBACK
  if (terms.length === 0) return { metric: 'memory-lexical', engine, reason: '', terms, results: [] }

  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : DEFAULT_LIMIT
  const db = openRead(capability.DatabaseSync, dbPath)
  let results = []
  try {
    if (engine === LEXICAL_ENGINES.FTS5) {
      // every term is [\p{L}\p{N}]+ — quoting it makes it a literal, never an operator
      const expression = terms.map((t) => `"${t}"`).join(' OR ')
      const rows = db.prepare('SELECT id, bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?').all(expression, cap)
      results = rows.map((r) => ({ id: String(r.id), score: -Number(r.score) }))
    } else {
      const totals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(len), 0) AS total FROM docs').get()
      const count = Number(totals && totals.n) || 0
      const avgdl = count ? Number(totals.total) / count : 0
      const lengths = new Map(db.prepare('SELECT id, len FROM docs').all().map((r) => [String(r.id), Number(r.len)]))
      const postings = db.prepare('SELECT id, tf FROM postings WHERE term = ?')

      const scores = new Map()
      for (const term of terms) {
        const rows = postings.all(term)
        if (rows.length === 0) continue
        const df = rows.length
        const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5))
        for (const row of rows) {
          const tf = Number(row.tf)
          const dl = lengths.get(String(row.id)) ?? 0
          const norm = avgdl > 0 ? dl / avgdl : 1
          const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * norm)
          const add = denominator > 0 ? idf * ((tf * (BM25_K1 + 1)) / denominator) : 0
          scores.set(String(row.id), (scores.get(String(row.id)) ?? 0) + add)
        }
      }
      results = [...scores.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, cap)
    }
  } finally {
    db.close()
  }

  return { metric: 'memory-lexical', engine, reason: '', terms, results: results.map((r, i) => ({ ...r, rank: i + 1 })) }
}

/**
 * indexStatus(opts) — is the index there, and does it still describe THIS corpus.
 *
 * Stale is a content comparison: the hash of what would be indexed now against the
 * hash recorded when it was. An absent index counts as stale, because the answer to
 * «can I trust this index» is no either way, and a status verb that reported a
 * missing index as fresh would be the most expensive kind of polite.
 */
export function indexStatus(opts = {}) {
  const { dbPath } = opts
  const capability = lexicalCapability(opts)
  const { visible, all } = visibleCorpus(opts)

  if (capability.engine === LEXICAL_ENGINES.UNAVAILABLE) {
    return {
      metric: 'memory-lexical-index-status',
      engine: LEXICAL_ENGINES.UNAVAILABLE,
      reason: capability.reason,
      db_path: dbPath ?? null,
      built_at: null,
      corpus_hash: null,
      indexed_hash: null,
      summary: { stale: 0, indexed: 0, corpus_notes: all.length, visible_notes: visible.length, exists: 0, engine_available: 0 },
    }
  }

  const meta = readMeta(dbPath)
  const exists = Boolean(dbPath) && existsSync(dbPath) && meta != null
  const hash = corpusHash(visible)
  const indexedHash = exists ? String(meta.corpus_hash ?? '') : null
  const sameSchema = exists && Number(meta.schema) === LEXICAL_SCHEMA_VERSION
  const stale = exists && sameSchema && indexedHash === hash ? 0 : 1

  return {
    metric: 'memory-lexical-index-status',
    engine: exists && meta.engine ? String(meta.engine) : capability.engine,
    reason: exists ? capability.reason : 'индекс не построен — `sma memory index rebuild`',
    db_path: dbPath ?? null,
    meta_path: dbPath ? metaPathFor(dbPath) : null,
    built_at: exists ? (meta.built_at ?? null) : null,
    corpus_hash: hash,
    indexed_hash: indexedHash,
    summary: {
      stale,
      indexed: exists ? Number(meta.indexed) || 0 : 0,
      corpus_notes: all.length,
      visible_notes: visible.length,
      exists: exists ? 1 : 0,
      engine_available: 1,
    },
  }
}
