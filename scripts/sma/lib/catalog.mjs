/**
 * catalog.mjs — the deterministic file catalog of the context compiler (9.3-05,
 * D-9.3-06). Every git-tracked repo file gets ONE one-line card = a pure function
 * of (file bytes, injected git data): path, language class, key symbols, import
 * targets, git stats (last-commit ISO + commit count), size. NOTHING is derived by
 * an LLM — the meaning-string is CUT (D-9.3-06, the grill's ruling on pillar 02 is
 * law; it revisits no earlier than after v1 field data). Same input → same card,
 * byte-for-byte.
 *
 * DETERMINISM CONTRACT (mirrors generator.mjs verbatim):
 *   - trackedFiles, gitStats {path:{lastCommit,commits}}, and commit are ARGUMENTS,
 *     never read inside this lib. NO child_process import here — the CLI obtains git
 *     data via the existing read-only execGit path (git ls-files / log / rev-parse /
 *     diff) and injects it.
 *   - buildCard emits a minified JSON line with FIXED key order (path, class,
 *     symbols, imports, git, bytes, lines) — fixed order is what makes byte-compare
 *     meaningful. A card carries identifiers, import specifiers and git stats ONLY;
 *     never file body text, string literals, values, wall-clock time or machine
 *     identity (a card is safe to show anywhere the path itself is safe — secrets
 *     live in file bodies, which the catalog never copies).
 *   - An incremental refresh is BYTE-IDENTICAL to a full rebuild at the same commit
 *     (Test 5 — freshness never costs determinism).
 *
 * cards.jsonl is a regenerable LOCAL artifact (gitignored .sma/catalog/) — rebuildable
 * anywhere, committed nowhere. Node built-ins only; zero npm deps; zero network; zero LLM.
 */

import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import { atomicWriteRaw } from './fs-atomics.mjs'

/** Catalog schema version — bumped only on a card-shape change (drift-safe). */
export const CATALOG_VERSION = 1

/** Per-card caps (overflow dropped deterministically from the END). */
const MAX_SYMBOLS = 24
const MAX_IMPORTS = 16
const MAX_TOKEN_CHARS = 80
const MAX_HEADING_CHARS = 120
/** Null-byte probe window — a control byte in the first 8 KiB means binary. */
const BINARY_PROBE_BYTES = 8192

// ─────────────────────────── classification ─────────────────────────────────

/** extension → language family. The deterministic «what it is» — no prose, no LLM. */
const CLASS_BY_EXT = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', rs: 'rs', go: 'go',
  md: 'md', markdown: 'md',
  json: 'config', yaml: 'config', yml: 'config', toml: 'config',
  css: 'css', scss: 'css', sql: 'sql', html: 'html', htm: 'html',
}

/** True when the probe carries a NUL in its first BINARY_PROBE_BYTES chars. */
function hasNullByte(probe) {
  const head = String(probe ?? '').slice(0, BINARY_PROBE_BYTES)
  return head.indexOf('\u0000') !== -1
}

/**
 * classifyFile(path, contentProbe) → a language class string. A null byte in the
 * first 8 KiB → 'binary' (never content-scanned further). Otherwise the extension
 * family map; an unknown extension classifies by its own extension token; a file
 * with no extension → 'other'.
 */
export function classifyFile(path, contentProbe = '') {
  if (hasNullByte(contentProbe)) return 'binary'
  const ext = extname(String(path ?? '')).slice(1).toLowerCase()
  if (CLASS_BY_EXT[ext]) return CLASS_BY_EXT[ext]
  return ext || 'other'
}

// ─────────────────────────── sanitize + caps ────────────────────────────────

/** Strip control chars (incl CR/LF) and cap — a card field can never span lines. */
function sanitizeToken(s, max = MAX_TOKEN_CHARS) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
}

/** Dedup preserving order, then cap the list dropping overflow from the END. */
function capList(arr, max) {
  const seen = new Set()
  const out = []
  for (const raw of arr) {
    const t = sanitizeToken(raw)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

/** Content → non-empty lines (CRLF-tolerant) — every extraction is line-anchored. */
function toLines(content) {
  return String(content ?? '').split(/\r?\n/)
}

// ─────────────────────────── extraction (js + md only) ──────────────────────
// Line-anchored regexes only (no backtracking-heavy patterns). Only the js family
// and md get extraction; every other class skips (D-9.3-06 deterministic v1).

const JS_SYMBOL_RES = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*module\.exports(?:\.([A-Za-z_$][\w$]*))?/,
  /^\s*exports\.([A-Za-z_$][\w$]*)/,
]

const JS_IMPORT_FROM_RE = /^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/
const JS_IMPORT_BARE_RE = /^\s*import\s+['"]([^'"]+)['"]/
const JS_REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g

/** First markdown heading text (sanitized) — the sole symbol of an md card. */
function firstHeading(content) {
  for (const line of toLines(content)) {
    const m = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/.exec(line)
    if (m) return sanitizeToken(m[1], MAX_HEADING_CHARS)
  }
  return null
}

/**
 * extractSymbols(content, cls) → declared/exported identifiers (js family) or the
 * first heading (md); every other class → []. Sanitized single-line, capped at 24.
 */
export function extractSymbols(content, cls) {
  if (cls === 'md') {
    const h = firstHeading(content)
    return h ? [h] : []
  }
  if (cls !== 'js') return []
  const found = []
  for (const line of toLines(content)) {
    for (const re of JS_SYMBOL_RES) {
      const m = re.exec(line)
      if (m && m[1]) found.push(m[1])
    }
  }
  return capList(found, MAX_SYMBOLS)
}

/**
 * extractImports(content, cls) → import/require specifiers (js family); every other
 * class → []. Sanitized single-line, capped at 16.
 */
export function extractImports(content, cls) {
  if (cls !== 'js') return []
  const found = []
  for (const line of toLines(content)) {
    const from = JS_IMPORT_FROM_RE.exec(line)
    if (from && from[1]) found.push(from[1])
    const bare = JS_IMPORT_BARE_RE.exec(line)
    if (bare && bare[1]) found.push(bare[1])
    JS_REQUIRE_RE.lastIndex = 0
    let r
    while ((r = JS_REQUIRE_RE.exec(line)) != null) {
      if (r[1]) found.push(r[1])
    }
  }
  return capList(found, MAX_IMPORTS)
}

// ─────────────────────────── card ───────────────────────────────────────────

/** The card OBJECT (fixed key order) — buildCard's stringified form. */
function cardObject({ path, content, gitStat }) {
  const cls = classifyFile(path, content)
  const symbols = cls === 'binary' ? [] : extractSymbols(content, cls)
  const imports = cls === 'binary' ? [] : extractImports(content, cls)
  const git = {
    lastCommit: gitStat && typeof gitStat.lastCommit === 'string' ? gitStat.lastCommit : '',
    commits: gitStat && Number.isFinite(gitStat.commits) ? gitStat.commits : 0,
  }
  const bytes = Buffer.byteLength(String(content ?? ''), 'utf8')
  const lines = content == null || content === '' ? 0 : String(content).split('\n').length
  // FIXED key order — byte-comparison depends on it.
  return { path: String(path), class: cls, symbols, imports, git, bytes, lines }
}

/**
 * buildCard({path, content, gitStat}) → one minified JSON line (a string). Pure:
 * same input → byte-identical output. The card carries ONLY the fixed field set.
 */
export function buildCard(args) {
  return JSON.stringify(cardObject(args))
}

// ─────────────────────────── build / read / write ───────────────────────────

/** Sort paths ascending (stable, locale-independent). */
function byPathAsc(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * buildCatalog({trackedFiles, readFile, gitStats, commit}) → {headerLine,
 * cardLines[], text}. Header record first ({v, commit}), then one card line per
 * tracked file sorted by path. A file whose readFile throws is skipped (fail-soft).
 * Rebuilding at the same commit is byte-identical.
 */
export function buildCatalog({ trackedFiles = [], readFile, gitStats = {}, commit = '' }) {
  const headerLine = JSON.stringify({ v: CATALOG_VERSION, commit: String(commit) })
  const sorted = [...trackedFiles].filter((p) => typeof p === 'string').sort(byPathAsc)
  const cardLines = []
  for (const path of sorted) {
    let content
    try {
      content = readFile(path)
    } catch {
      continue // unreadable file → no card (fail-soft)
    }
    cardLines.push(buildCard({ path, content, gitStat: gitStats[path] }))
  }
  const text = [headerLine, ...cardLines].join('\n') + '\n'
  return { headerLine, cardLines, text }
}

/** Persist a catalog atomically to <catalogDir>/cards.jsonl. */
export function writeCatalog({ catalog, catalogDir }) {
  atomicWriteRaw(join(catalogDir, 'cards.jsonl'), catalog.text)
}

/**
 * readCatalog({catalogDir, readFile}) → {built, v, commit, cards[], cardLines[],
 * corrupt} or {built:false}. Tolerant: a corrupt line is skipped-and-counted; a
 * missing file → {built:false}. cards are parsed objects; cardLines the raw strings.
 */
export function readCatalog({ catalogDir, readFile }) {
  let raw
  try {
    const rf = readFile ?? defaultRead
    raw = rf(join(catalogDir, 'cards.jsonl'))
  } catch {
    return { built: false }
  }
  const nb = String(raw ?? '').split('\n').filter((l) => l.trim() !== '')
  if (!nb.length) return { built: false }
  let header
  try {
    header = JSON.parse(nb[0])
  } catch {
    return { built: false }
  }
  if (!header || typeof header !== 'object') return { built: false }
  const cards = []
  const cardLines = []
  let corrupt = 0
  for (let i = 1; i < nb.length; i++) {
    try {
      const obj = JSON.parse(nb[i])
      if (obj && typeof obj.path === 'string') {
        cards.push(obj)
        cardLines.push(nb[i])
      } else {
        corrupt += 1
      }
    } catch {
      corrupt += 1
    }
  }
  return { built: true, v: header.v ?? null, commit: String(header.commit ?? ''), cards, cardLines, corrupt }
}

/** Default reader (only used when the CLI does not inject one). */
function defaultRead(p) {
  return readFileSync(p, 'utf8')
}

/**
 * refreshCatalog({catalog, changed, deleted, readFile, gitStats, commit}) → the same
 * shape as buildCatalog. Pure patch: re-cards ONLY the named changed entries, drops
 * deleted, updates the header commit, re-sorts by path, re-renders. The result is
 * BYTE-IDENTICAL to buildCatalog run full at the new commit over the same tree — the
 * equivalence that proves freshness never costs determinism (Test 5).
 *
 * @param {{catalog:object, changed?:string[], deleted?:string[], readFile:Function, gitStats?:object, commit?:string}} args
 */
export function refreshCatalog({ catalog, changed = [], deleted = [], readFile, gitStats = {}, commit = '' }) {
  const byPath = new Map()
  const src = catalog && Array.isArray(catalog.cards) ? catalog.cards : []
  for (const card of src) byPath.set(card.path, JSON.stringify(card))
  for (const p of deleted) byPath.delete(p)
  for (const p of changed) {
    let content
    try {
      content = readFile(p)
    } catch {
      byPath.delete(p) // unreadable (e.g. now-gone) → drop, never a torn card
      continue
    }
    byPath.set(p, buildCard({ path: p, content, gitStat: gitStats[p] }))
  }
  const headerLine = JSON.stringify({ v: CATALOG_VERSION, commit: String(commit) })
  const sortedPaths = [...byPath.keys()].sort(byPathAsc)
  const cardLines = sortedPaths.map((p) => byPath.get(p))
  const text = [headerLine, ...cardLines].join('\n') + '\n'
  return { headerLine, cardLines, text }
}

/**
 * checkCatalog({catalog, readFile, gitStatsAtCommit}) → {built, drift, driftPaths[]}.
 * MEM-REGEN posture: regenerate every stored card from the INJECTED inputs (the CLI
 * wires these to the catalog's OWN header commit — content + git stats as of it) and
 * byte-compare to the stored line. An edited stored card counts drift 1; a moved HEAD
 * with an untouched catalog counts drift 0 (stale is a freshness fact for the stream,
 * never drift — the caller regenerates at the header commit, not at HEAD). A missing
 * catalog returns {built:false} which the CLI prints as -1 (honest not-built sentinel).
 */
export function checkCatalog({ catalog, readFile, gitStatsAtCommit = {} }) {
  if (!catalog || catalog.built === false) return { built: false }
  const cards = Array.isArray(catalog.cards) ? catalog.cards : []
  const lines = Array.isArray(catalog.cardLines) ? catalog.cardLines : []
  let drift = 0
  const driftPaths = []
  for (let i = 0; i < cards.length; i++) {
    const stored = lines[i] ?? JSON.stringify(cards[i])
    let content
    try {
      content = readFile(cards[i].path)
    } catch {
      continue // unreadable at the header commit → cannot regenerate → not counted
    }
    const regenerated = buildCard({ path: cards[i].path, content, gitStat: gitStatsAtCommit[cards[i].path] })
    if (regenerated !== stored) {
      drift += 1
      driftPaths.push(cards[i].path)
    }
  }
  return { built: true, drift, driftPaths }
}

// ─────────────────────────── find (catalog before grep) ─────────────────────

/** Lowercase word tokens of a string (non-word split, empties dropped). */
function tokenize(s) {
  return String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
}

/** The searchable whole-token set of a card: path + symbols + imports. */
function cardTokens(card) {
  const set = new Set()
  for (const t of tokenize(card.path)) set.add(t)
  for (const s of card.symbols ?? []) for (const t of tokenize(s)) set.add(t)
  for (const im of card.imports ?? []) for (const t of tokenize(im)) set.add(t)
  return set
}

/**
 * findCards({catalog, query, limit, boostClasses}) → ranked card OBJECTS (never
 * mutated — safe to re-stringify verbatim into a pack). Ranking:
 *   whole-token match count desc → (boosted class, when boostClasses given) desc →
 *   git.lastCommit desc → path asc.
 * Whole-token equality only (no substring fuzz — determinism over cleverness). A
 * query with zero matches returns [] (the CLI then falls back to grep — step two of
 * the search rule).
 *
 * @param {{catalog:object, query:string, limit?:number, boostClasses?:Set<string>|string[]}} args
 */
export function findCards({ catalog, query, limit = 20, boostClasses = [] }) {
  if (!catalog || !Array.isArray(catalog.cards)) return []
  const qTokens = new Set(tokenize(query))
  if (qTokens.size === 0) return []
  const boost = boostClasses instanceof Set ? boostClasses : new Set(boostClasses)
  const scored = []
  for (const card of catalog.cards) {
    const tokens = cardTokens(card)
    let matches = 0
    for (const q of qTokens) if (tokens.has(q)) matches += 1
    if (matches === 0) continue
    scored.push({ card, matches, boosted: boost.has(card.class) ? 1 : 0 })
  }
  scored.sort((a, b) => {
    if (b.matches !== a.matches) return b.matches - a.matches
    if (b.boosted !== a.boosted) return b.boosted - a.boosted
    const da = a.card.git?.lastCommit ?? ''
    const db = b.card.git?.lastCommit ?? ''
    if (db !== da) return db < da ? -1 : 1 // last-commit desc
    return byPathAsc(a.card.path, b.card.path)
  })
  const lim = Number.isFinite(limit) && limit > 0 ? limit : scored.length
  return scored.slice(0, lim).map((s) => s.card)
}
