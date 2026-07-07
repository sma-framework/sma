/**
 * consolidate.mjs — the P3 consolidation core (49.1-12, B5/FI-9): a PROPOSE-ONLY
 * review pass over the memory corpus. Structural analog of lint.mjs's runLint —
 * pure read → collect proposals → structured return. The lib NEVER writes;
 * rendering/persisting is the CLI layer's job and APPLYING any proposal is the
 * operator's reviewed action (T-49.1-23).
 *
 * TRIGGER CONTRACT (event-driven, never a daemon/clock): run `pnpm sma
 * consolidate` at every ~25 commits touching .claude/memory/** OR at
 * milestone-complete. No scheduler, no background process — the single
 * HIGH-confidence constraint across all research lanes (RESEARCH Pattern 3).
 *
 * FI-9 (carried-forward lock): memory is NEVER deleted or time-decayed.
 * Promotion counters are usage-evidence based (49.1-11's citation ledger);
 * dead weight demotes via 49.1-13's trim, consolidation only proposes.
 *
 * Exports (consumed by the CLI `consolidate` subcommand + lint's MEM-CONTRADICT):
 *   - propose(opts)            -> {merges, promotions, contradictions, digest}
 *   - digest(opts)             -> {topCited, incidents, summary}
 *   - findContradictions(opts) -> contradiction pairs (the ONE shared detector —
 *       lint.mjs imports THIS, single implementation, 49.1-12 T2 acceptance)
 *
 * DESIGN INVARIANTS:
 *   - READ-ONLY: imports ONLY read APIs from node:fs. Zero write calls (test 5).
 *   - DETERMINISTIC: token-set overlap, no embeddings (hot-path lock); same
 *     tree + ledgers → identical proposals.
 *   - FAIL-SOFT: a missing corpus/ledger/journal yields empty proposals, never
 *     a throw (C9).
 *
 * Node built-ins only; all dirs dependency-injectable.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

import { parseNote, loadTagsRegistry, resolveAlias } from './frontmatter.mjs'
import { readUsage, usageStats } from './citations.mjs'
import { readJournal } from './journal.mjs'

// ── thresholds (deterministic, test-pinned) ──────────────────────────────────

/** Token-set Jaccard at/above which two same-area+kind bodies are a MERGE candidate. */
const MERGE_SIMILARITY = 0.5

/** Distinct task-tag-sets at/above which an episodic note is a PROMOTE candidate. */
const PROMOTION_THRESHOLD = 3

/** Kinds that participate in contradiction detection (bi-temporal subject model). */
const CONTRADICT_KINDS = new Set(['decision', 'status'])

/** Episodic-class kinds eligible for episodic→semantic promotion. */
const EPISODIC_KINDS = new Set(['episodic', 'status'])

/** The durable kind an episodic note promotes to. */
const PROMOTE_TARGET = 'procedural-rule'

/** How many top-cited notes the reflection digest lists. */
const DIGEST_TOP = 5

/** A journal event class repeated at/above this count is a digest incident class. */
const INCIDENT_REPEAT = 2

/** Minimum shared subject tokens before two claims can conflict. */
const MIN_SHARED_SUBJECT = 2

/** Structural corpus files that are never notes (mirrors loader.mjs/lint.mjs). */
const STRUCTURAL_FILES = new Set(['MEMORY.md', 'ARCHIVE.md', 'TAGS.md'])

// ── corpus read (fail-soft, mirrors loader.mjs) ──────────────────────────────

function listNoteFiles(corpusDir) {
  let entries
  try {
    entries = readdirSync(corpusDir)
  } catch {
    return []
  }
  return entries
    // The FI-11 per-area INDEX-<area>.md files (49.1-13) are structural, not notes.
    .filter((f) => f.endsWith('.md') && !STRUCTURAL_FILES.has(f) && !/^INDEX-[^/\\]+\.md$/.test(f))
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
function readCorpus(corpusDir) {
  const notes = []
  for (const file of listNoteFiles(corpusDir)) {
    let text
    try {
      text = readFileSync(join(corpusDir, file), 'utf8')
    } catch {
      continue
    }
    let parsed
    try {
      parsed = parseNote(text, { file })
    } catch {
      continue
    }
    if (parsed.frontmatter == null) continue
    notes.push({ file, frontmatter: parsed.frontmatter, body: parsed.body ?? '' })
  }
  return notes
}

/** Load the tag registry (fail-soft: empty facets when TAGS.md is unreadable). */
function loadRegistry(tagsPath) {
  try {
    return loadTagsRegistry(tagsPath)
  } catch {
    return { area: new Set(), kind: new Set(), aliases: new Map() }
  }
}

// ── deterministic token helpers (no embeddings — hot-path lock) ──────────────

/** Raw lowercase word tokens (keeps short polarity words like "no"). */
function rawTokens(s) {
  return String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9а-яё]+/i)
    .filter(Boolean)
}

/** Words that carry claim polarity, not subject matter. */
const NEG_MARKERS = new Set(['never', 'not', 'no', 'dont', 'forbidden', 'banned', 'disable', 'disabled', 'reject', 'avoid', 'without'])
const POS_MARKERS = new Set(['always', 'must', 'use', 'enable', 'enabled', 'allow', 'allowed', 'prefer', 'require', 'required'])

/** Subject tokens: content words (len >= 3) minus polarity markers. */
function subjectTokens(raws) {
  const out = new Set()
  for (const t of raws) {
    if (t.length < 3) continue
    if (NEG_MARKERS.has(t) || POS_MARKERS.has(t)) continue
    out.add(t)
  }
  return out
}

/** Claim polarity: negation dominates ("never use X" is negative). */
function polarity(raws) {
  let pos = false
  for (const t of raws) {
    if (NEG_MARKERS.has(t)) return 'neg'
    if (POS_MARKERS.has(t)) pos = true
  }
  return pos ? 'pos' : null
}

/** Numbers mentioned in a claim (numeric-disagreement channel). */
function numbersOf(s) {
  return (String(s ?? '').match(/\d+(?:\.\d+)?/g) ?? []).sort()
}

/** Token-set Jaccard similarity of two Sets. */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

// ── shared note predicates ───────────────────────────────────────────────────

/** Resolve a note's kind to canonical via the registry aliases. */
function kindOf(note, registry) {
  return resolveAlias(String(note.frontmatter?.kind ?? '').trim(), registry)
}

/** A note's area-facet tags (alias-resolved); falls back to ALL tags when the
 * registry has no area facet (fixture-less callers stay usable). */
function areaTagsOf(note, registry) {
  const tags = Array.isArray(note.frontmatter?.tags) ? note.frontmatter.tags : []
  const resolved = tags.map((t) => resolveAlias(String(t), registry))
  if (registry.area.size === 0) return new Set(resolved)
  const areas = resolved.filter((t) => registry.area.has(t))
  return new Set(areas.length ? areas : resolved)
}

/** Bi-temporal activity: a note is ACTIVE while it has no valid_until and no
 * superseded_by — setting either is the supersession fix path (B5). */
function isActive(fm) {
  const until = fm?.valid_until
  const by = fm?.superseded_by
  return (until == null || String(until).trim() === '') && (by == null || String(by).trim() === '')
}

/** True when the pair is already linked via supersedes/superseded_by. */
function isLinked(a, b) {
  const ref = (v) => (v == null ? '' : basename(String(v).trim()))
  const fa = a.frontmatter ?? {}
  const fb = b.frontmatter ?? {}
  return (
    ref(fa.supersedes) === b.file ||
    ref(fa.superseded_by) === b.file ||
    ref(fb.supersedes) === a.file ||
    ref(fb.superseded_by) === a.file
  )
}

/** Two Sets share at least one member. */
function sharesAny(a, b) {
  for (const t of a) if (b.has(t)) return true
  return false
}

// ── contradiction detection (the ONE implementation — lint imports this) ─────

/**
 * detectClaimConflict(descA, descB) — deterministic same-subject conflict
 * heuristic: enough shared subject tokens AND (opposing polarity markers OR
 * numeric disagreement). Returns {shared, opposing, numeric} or null.
 */
export function detectClaimConflict(descA, descB) {
  const rawA = rawTokens(descA)
  const rawB = rawTokens(descB)
  const subjA = subjectTokens(rawA)
  const subjB = subjectTokens(rawB)
  const shared = [...subjA].filter((t) => subjB.has(t)).sort()
  if (shared.length < MIN_SHARED_SUBJECT) return null

  const pa = polarity(rawA)
  const pb = polarity(rawB)
  const opposing = (pa === 'neg' && pb === 'pos') || (pa === 'pos' && pb === 'neg')

  const na = numbersOf(descA)
  const nb = numbersOf(descB)
  const numeric = na.length > 0 && nb.length > 0 && JSON.stringify(na) !== JSON.stringify(nb)

  if (!opposing && !numeric) return null
  return { shared, opposing, numeric }
}

/**
 * findContradictions({notes, registry}) — same-subject conflicting
 * decision/status pairs with NO supersedes/superseded_by/valid_until linkage
 * (MEM-CONTRADICT's subject model — the parallel-terminal contradiction class).
 * Detection only; resolution (set valid_until or supersedes on the stale one)
 * is a human review action — Zep-style contradiction DETECTION without the
 * graph engine (RESEARCH Don't-Hand-Roll).
 *
 * @param {{notes:Array<{file:string, frontmatter:object}>, registry?:object}} opts
 * @returns {Array<{files:[string,string], kind:string, area:string[], shared:string[], reason:string}>}
 */
export function findContradictions(opts = {}) {
  const notes = Array.isArray(opts.notes) ? opts.notes.filter((n) => n && n.frontmatter) : []
  const registry = opts.registry ?? { area: new Set(), kind: new Set(), aliases: new Map() }

  const candidates = notes.filter((n) => CONTRADICT_KINDS.has(kindOf(n, registry)))
  const out = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      if (kindOf(a, registry) !== kindOf(b, registry)) continue
      const areaA = areaTagsOf(a, registry)
      const areaB = areaTagsOf(b, registry)
      if (!sharesAny(areaA, areaB)) continue
      // Supersession resolves it: an inactive note (valid_until / superseded_by)
      // or an explicit link between the pair is NOT a contradiction.
      if (!isActive(a.frontmatter) || !isActive(b.frontmatter)) continue
      if (isLinked(a, b)) continue

      const conflict = detectClaimConflict(a.frontmatter.description, b.frontmatter.description)
      if (!conflict) continue

      const files = [a.file, b.file].sort()
      const sharedArea = [...areaA].filter((t) => areaB.has(t)).sort()
      out.push({
        files,
        kind: kindOf(a, registry),
        area: sharedArea,
        shared: conflict.shared,
        reason: conflict.opposing ? 'opposing polarity markers' : 'numeric disagreement',
      })
    }
  }
  return out.sort((x, y) => (x.files[0] < y.files[0] ? -1 : x.files[0] > y.files[0] ? 1 : 0))
}

// ── merge + promotion proposals ──────────────────────────────────────────────

/** Near-duplicate pairs: same kind, shared area, body token-set Jaccard >= threshold. */
function findMerges(notes, registry, threshold) {
  const bodies = new Map()
  const bodyTokens = (n) => {
    if (!bodies.has(n.file)) bodies.set(n.file, subjectTokens(rawTokens(n.body)))
    return bodies.get(n.file)
  }
  const out = []
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i]
      const b = notes[j]
      if (kindOf(a, registry) !== kindOf(b, registry)) continue
      if (!sharesAny(areaTagsOf(a, registry), areaTagsOf(b, registry))) continue
      if (isLinked(a, b)) continue // a superseded pair is already resolved
      const sim = jaccard(bodyTokens(a), bodyTokens(b))
      if (sim < threshold) continue
      out.push({
        files: [a.file, b.file].sort(),
        similarity: Math.round(sim * 100) / 100,
        kind: kindOf(a, registry),
      })
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity || (x.files[0] < y.files[0] ? -1 : 1))
}

/**
 * Promotion counters (promotion-NOT-time-decay, FI-9): an episodic note cited
 * by >= PROMOTION_THRESHOLD DISTINCT task-tag-sets in the usage ledger
 * (49.1-11's citation data) is proposed for episodic→semantic promotion.
 * A citation event's task-tag-set key = its sorted `tags` array when recorded;
 * events without tags fall back to their session key (one session ≈ one task).
 */
function findPromotions(notes, registry, usageOpts, threshold) {
  let events = []
  try {
    events = readUsage(usageOpts).events
  } catch {
    /* fail-soft — no usage data, no promotions */
  }

  const setsByNote = new Map()
  for (const e of events) {
    if (!e || !e.noteId) continue
    const key =
      Array.isArray(e.tags) && e.tags.length
        ? [...e.tags].map(String).sort().join(',')
        : `session:${e.session ?? e.terminal ?? 'unknown'}`
    if (!setsByNote.has(e.noteId)) setsByNote.set(e.noteId, new Set())
    setsByNote.get(e.noteId).add(key)
  }

  const out = []
  for (const n of notes) {
    const kind = kindOf(n, registry)
    if (!EPISODIC_KINDS.has(kind)) continue
    if (kind === PROMOTE_TARGET) continue
    const distinct = setsByNote.get(n.file)?.size ?? 0
    if (distinct < threshold) continue
    out.push({ file: n.file, from: kind, to: PROMOTE_TARGET, distinctTagSets: distinct })
  }
  return out.sort((x, y) => y.distinctTagSets - x.distinctTagSets || (x.file < y.file ? -1 : 1))
}

// ── reflection digest ────────────────────────────────────────────────────────

/**
 * digest(opts) — the generative-agents-style reflection summary over the usage
 * ledger + coordination journal window: which notes are actually earning their
 * keep (top-cited) and which incident classes keep repeating.
 *
 * @param {{usageDir?:string, journalDir?:string, top?:number}} [opts]
 * @returns {{topCited:Array, incidents:Array<{type:string,count:number}>, summary:string}}
 */
export function digest(opts = {}) {
  const top = Number.isFinite(opts.top) ? opts.top : DIGEST_TOP

  let notes = []
  try {
    notes = usageStats({ usageDir: opts.usageDir, journalDir: opts.journalDir }).notes
  } catch {
    /* fail-soft */
  }
  const topCited = notes.slice(0, top)

  const counts = new Map()
  try {
    const { events } = readJournal({ journalDir: opts.journalDir })
    for (const e of events) {
      const type = e && typeof e.type === 'string' ? e.type : 'unknown'
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
  } catch {
    /* fail-soft — no journal, no incident classes */
  }
  const incidents = [...counts.entries()]
    .filter(([, count]) => count >= INCIDENT_REPEAT)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))

  const citedPart = topCited.length
    ? `top-cited: ${topCited.map((n) => `${n.noteId} (${n.total})`).join(', ')}`
    : 'top-cited: none yet'
  const incidentPart = incidents.length
    ? `repeated incident classes: ${incidents.map((i) => `${i.type}×${i.count}`).join(', ')}`
    : 'repeated incident classes: none'

  return { topCited, incidents, summary: `${citedPart}; ${incidentPart}` }
}

// ── the propose() entrypoint ─────────────────────────────────────────────────

/**
 * propose(opts) — the pure review pass: merges + promotions + contradictions +
 * reflection digest, NEVER a disk write (runLint contract — the CLI renders,
 * a human applies). FI-9: nothing here deletes or decays memory.
 *
 * @param {object} opts
 * @param {string} opts.corpusDir   directory of the memory notes
 * @param {string} [opts.tagsPath]  path to TAGS.md (defaults to corpusDir/TAGS.md)
 * @param {string} [opts.usageDir]  .sma/usage ledger dir (49.1-11 promotion evidence)
 * @param {string} [opts.journalDir] .sma/journal dir (digest incident classes)
 * @param {number} [opts.promotionThreshold] distinct tag-sets to propose promotion
 * @param {number} [opts.mergeSimilarity]    Jaccard threshold for merge proposals
 * @returns {{merges:Array, promotions:Array, contradictions:Array, digest:object}}
 */
export function propose(opts = {}) {
  const corpusDir = opts.corpusDir
  const tagsPath = opts.tagsPath ?? (corpusDir ? join(corpusDir, 'TAGS.md') : null)
  const registry = tagsPath
    ? loadRegistry(tagsPath)
    : { area: new Set(), kind: new Set(), aliases: new Map() }
  const notes = corpusDir ? readCorpus(corpusDir) : []

  const usageOpts = { usageDir: opts.usageDir, journalDir: opts.journalDir }
  const promotionThreshold = Number.isFinite(opts.promotionThreshold)
    ? opts.promotionThreshold
    : PROMOTION_THRESHOLD
  const mergeSimilarity = Number.isFinite(opts.mergeSimilarity)
    ? opts.mergeSimilarity
    : MERGE_SIMILARITY

  return {
    merges: findMerges(notes, registry, mergeSimilarity),
    promotions: findPromotions(notes, registry, usageOpts, promotionThreshold),
    contradictions: findContradictions({ notes, registry }),
    digest: digest({ usageDir: opts.usageDir, journalDir: opts.journalDir }),
  }
}
