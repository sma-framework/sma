/**
 * consolidate.mjs — the P3 consolidation core (B5/FI-9): a PROPOSE-ONLY
 * review pass over the memory corpus. Structural analog of lint.mjs's runLint —
 * pure read → collect proposals → structured return. The lib NEVER writes;
 * rendering/persisting is the CLI layer's job and APPLYING any proposal is the
 * operator's reviewed action.
 *
 * TRIGGER CONTRACT (event-driven, never a daemon/clock): run `pnpm sma
 * consolidate` at every ~25 commits touching .claude/memory/** OR at
 * milestone-complete. No scheduler, no background process — the single
 * HIGH-confidence constraint across all research lanes (RESEARCH Pattern 3).
 *
 * FI-9 (carried-forward lock): memory is NEVER deleted or time-decayed.
 * Promotion counters are usage-evidence based (the citation ledger);
 * dead weight demotes via the trim, consolidation only proposes.
 *
 * Exports (consumed by the CLI `consolidate` subcommand + lint's MEM-CONTRADICT):
 *   - propose(opts)            -> {merges, promotions, contradictions, digest}
 *   - digest(opts)             -> {topCited, incidents, summary}
 *   - findContradictions(opts) -> contradiction pairs (the ONE shared detector —
 *       lint.mjs imports THIS, single implementation)
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
import { projectNoteAxis } from './generator.mjs'
import { readUsage, usageStats } from './citations.mjs'
import { readJournal } from './journal.mjs'

// ── thresholds (deterministic, test-pinned) ──────────────────────────────────

/** Token-set Jaccard at/above which two same-area+kind bodies are a MERGE candidate. */
const MERGE_SIMILARITY = 0.5

/** Distinct task-tag-sets at/above which an episodic note is a PROMOTE candidate. */
const PROMOTION_THRESHOLD = 3

/**
 * Kinds that participate in contradiction detection (bi-temporal subject model).
 *
 * WIDENED because the narrow set was MEASURED, not read. It held {decision,
 * status} — and the kind histogram of the live corpus, taken through this
 * module's own `projectNoteAxis` projection, is {bug-lesson, normative,
 * prospective, preference, procedural-rule, semantic}: twenty-six records, not
 * one of them `decision` or `status`. The candidate set was therefore empty
 * BEFORE `detectClaimConflict` was ever called, and the empty result read as
 * «the corpus has no contradictions» when it meant «the detector did not look».
 * `sma consolidate`, lint's MEM-CONTRADICT and the write-time proposal were all
 * silent for that one reason.
 *
 * The two added kinds are the ones schema v2 actually produces for a record that
 * STATES A RULE: `normative` (memory_type: normative) and `procedural-rule`
 * (memory_type: procedural + truth_mode: normative). They are the shape the
 * bi-temporal model was written for — a standing claim that a later claim can
 * contradict and that supersession resolves.
 *
 * DELIBERATELY STILL A GATE. `semantic`, `bug-lesson`, `preference`,
 * `prospective` and `episodic` stay out. Two facts stated differently are a
 * MERGE question, and `findMerges` already owns subject overlap; a detector that
 * fired on every kind would be tuned to a benchmark rather than to a rule, which
 * is exactly the benchmark-tuning the house forbids.
 */
const CONTRADICT_KINDS = new Set(['decision', 'status', 'normative', 'procedural-rule'])

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
    // The FI-11 per-area INDEX-<area>.md files are structural, not notes.
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

/**
 * Read + parse every note (fail-soft: a bad note is skipped, not thrown).
 *
 * EXPORTED (v5.2): the memory benchmark asks this module what a corpus states about
 * ITSELF — which records are retired, which pairs it already calls a contradiction.
 * A measurer that opened the corpus with its own reader would be a second read path,
 * which is a second answer that drifts unnoticed. One reader, one answer.
 */
export function readCorpus(corpusDir) {
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
    notes.push({
      file,
      frontmatter: parsed.frontmatter,
      body: parsed.body ?? '',
      schemaVersion: parsed.schemaVersion,
    })
  }
  return notes
}

/**
 * A note's fields on the SHARED axis, whichever grammar it is written in
 * (memoized per note object; a caller may inject notes that never went through
 * readCorpus, so this must not depend on readCorpus having run).
 *
 * Every question this module asks a note — what kind is it, which areas is it
 * in, what does it claim — is asked in v1 field names, and a schema-v2 record
 * answers none of them: no `kind`, no `tags`, no `description`. The effect was
 * not an error but a SILENCE: v2 records fell out of every pair loop (no shared
 * area can be found in an empty tag list), so `sma consolidate` reported a clean
 * corpus on a migrated one — no contradictions, no near-duplicates, nothing to
 * review. The projection is the generator's, so consolidate sees exactly the
 * corpus the index describes.
 */
const AXIS_CACHE = new WeakMap()

function axisOf(note) {
  if (note == null || typeof note !== 'object') return projectNoteAxis({})
  let axis = AXIS_CACHE.get(note)
  if (!axis) {
    axis = projectNoteAxis(note.frontmatter ?? {}, {
      file: note.file ?? '',
      schemaVersion: note.schemaVersion,
    })
    AXIS_CACHE.set(note, axis)
  }
  return axis
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

/**
 * Words that carry claim polarity, not subject matter.
 *
 * BILINGUAL because the corpus is. Every marker here was English while the live
 * corpus's twelve `normative` records are written in Russian, so `polarity()`
 * returned null for claims that plainly state an obligation or a prohibition —
 * the same defect class as the injection markers whose Russian half was dead
 * code. The Russian entries are matched exactly the way the English ones are:
 * as WHOLE TOKENS off `rawTokens`, never as substrings, so «нет» cannot fire
 * inside «нетривиальный».
 *
 * NOT A STEMMER, and the limit is stated rather than implied: only the base
 * forms are listed, so «должна»/«запрещена» and other inflections are not
 * reached, and neither is the harder case — an opposition carried by VERB
 * ANTONYMY («снимок остаётся на месте» versus «удалите ночной снимок») rather
 * than by clause polarity. No marker list of any size reaches that one; it is
 * pinned as a known limit in consolidate.test.ts (Test 7b).
 */
const NEG_MARKERS = new Set([
  'never', 'not', 'no', 'dont', 'forbidden', 'banned', 'disable', 'disabled', 'reject', 'avoid', 'without',
  'не', 'нет', 'никогда', 'нельзя', 'запрещено',
])
const POS_MARKERS = new Set([
  'always', 'must', 'use', 'enable', 'enabled', 'allow', 'allowed', 'prefer', 'require', 'required',
  'только', 'обязан', 'всегда', 'должен', 'следует', 'нужно',
])

/** A token carries subject matter only if it carries a letter (Latin or Cyrillic). */
const HAS_LETTER = /[a-zа-яё]/i

/**
 * Subject tokens: content WORDS (len >= 3) minus polarity markers.
 *
 * A BARE NUMERAL IS NOT A SUBJECT, and the rule is stated rather than tuned. A
 * token of pure digits is a QUANTITY, and quantities are the numeric channel's
 * business one function below; admitting them here let the same «2026» count as
 * shared subject matter AND as numeric disagreement, so two founder rules whose
 * only overlap was the year they were given scored as a same-subject conflict.
 * Requiring one letter is the type correction, not a threshold: it says what a
 * subject IS. Measured on the live 26-note corpus, it removes 4 of 14 findings
 * and adds none — every one of the four was a date collision (the detector's
 * known false-positive condition).
 */
function subjectTokens(raws) {
  const out = new Set()
  for (const t of raws) {
    if (t.length < 3) continue
    if (!HAS_LETTER.test(t)) continue
    if (NEG_MARKERS.has(t) || POS_MARKERS.has(t)) continue
    out.add(t)
  }
  return out
}

/**
 * The parts of a claim that can each carry their own polarity.
 *
 * A claim is one SENTENCE in this corpus, but rarely one statement: the rules
 * people actually write hang several assertions off one period — a rule, its
 * scope, an example, a closing aside. Reading polarity over the whole sentence
 * lets a marker in the closing aside speak for a subject named three clauses
 * earlier, which is how two rules that merely MENTION the same two words end up
 * reported as denying each other. Splitting first is what makes the co-location
 * rule below expressible at all.
 *
 * Boundaries are the ones the language marks: sentence punctuation, the
 * semicolon and colon that join independent statements, the comma that opens a
 * subordinate or coordinate clause, and a newline. A period is a boundary only
 * when whitespace or the end follows it, so `package.json` and a file name stay
 * whole. Dashes are deliberately NOT boundaries — in Russian the dash is most
 * often the copula, and splitting there would cut a statement from its subject.
 */
function clausesOf(s) {
  const parts = String(s ?? '')
    .split(/[.!?…](?=\s|$)|[;:,\n]/)
    .map((c) => c.trim())
    .filter(Boolean)
  return parts.length ? parts : [String(s ?? '')]
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

/**
 * Dates written the way this corpus writes them: `2026-08-03`, `31.07.2026`,
 * `2026/08/03`, and a bare four-digit year.
 */
const DATE_LIKE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}\b|\b(?:19|20)\d{2}\b/g

/**
 * Numbers mentioned in a claim (numeric-disagreement channel).
 *
 * A DATE IS NOT A QUANTITY IN DISPUTE. Timestamps are stripped before the
 * numbers are read, and the reason is the module's own model rather than any
 * measurement: this is the BI-TEMPORAL subject detector, and WHEN a claim was
 * made is already owned by `valid_from`/`valid_until` and honoured above by
 * `isActive`. Two rules the founder gave on different days are SEQUENTIAL, not
 * contradictory — reading their dates as disagreeing quantities made every pair
 * of dated rules a critical finding. Measured on the live 26-note corpus,
 * stripping dates removes 10 of 14 findings and adds none.
 *
 * The channel keeps its job: a claim saying «keep 3 backups» against one saying
 * «keep 7» still disagrees, because neither number is a date.
 */
function numbersOf(s) {
  return (String(s ?? '').replace(DATE_LIKE, ' ').match(/\d+(?:\.\d+)?/g) ?? []).sort()
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
  return resolveAlias(axisOf(note).kind, registry)
}

/** A note's area-facet tags (alias-resolved); falls back to ALL tags when the
 * registry has no area facet (fixture-less callers stay usable). */
function areaTagsOf(note, registry) {
  const resolved = axisOf(note).tags.map((t) => resolveAlias(String(t), registry))
  if (registry.area.size === 0) return new Set(resolved)
  const areas = resolved.filter((t) => registry.area.has(t))
  return new Set(areas.length ? areas : resolved)
}

/** The one-line claim a note makes, under either grammar's field name. */
function claimOf(note) {
  return axisOf(note).description
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
 * The polarity channel's evidence: the overlap of two clauses that are BOTH
 * about the same thing and opposed about it. Returns the shared subject tokens
 * of the strongest such clause pair, or null when no clause of one claim denies
 * a clause of the other.
 *
 * CO-LOCATION IS THE RULE, and it is a statement about what an opposition IS,
 * not a threshold: a claim denies another claim only where they are speaking of
 * the same subject. Whole-sentence polarity had no way to say this, so a
 * negation anywhere in a long rule opposed an affirmation anywhere in another,
 * and the shared subject that licensed the pair could sit in clauses neither
 * marker belonged to. Measured on a live 35-note corpus, that shape was the
 * whole of the rule's output: two critical findings, both false, zero true —
 * and both disappear here while every true positive above still fires, because
 * a real opposition puts the marker and the subject in one clause.
 */
function opposedClauseOverlap(descA, descB) {
  const analyse = (desc) =>
    clausesOf(desc)
      .map((c) => {
        const raws = rawTokens(c)
        return { pol: polarity(raws), subj: subjectTokens(raws) }
      })
      .filter((c) => c.pol !== null)
  const ca = analyse(descA)
  const cb = analyse(descB)

  let best = null
  for (const a of ca) {
    for (const b of cb) {
      if (a.pol === b.pol) continue
      const shared = [...a.subj].filter((t) => b.subj.has(t)).sort()
      if (shared.length < MIN_SHARED_SUBJECT) continue
      if (best === null || shared.length > best.length) best = shared
    }
  }
  return best
}

/**
 * detectClaimConflict(descA, descB) — deterministic same-subject conflict
 * heuristic: enough shared subject tokens AND (opposing polarity markers on the
 * same subject OR numeric disagreement). Returns {shared, opposing, numeric} or
 * null.
 *
 * The numeric channel stays whole-claim on purpose: a quantity in dispute is
 * already pinned to its own subject by being a number this corpus does not
 * write twice, and date stripping above removed the false shape that channel
 * actually produced. Narrowing a channel nobody measured as wrong would be
 * tuning, not a correction.
 */
export function detectClaimConflict(descA, descB) {
  const rawA = rawTokens(descA)
  const rawB = rawTokens(descB)
  const subjA = subjectTokens(rawA)
  const subjB = subjectTokens(rawB)
  const shared = [...subjA].filter((t) => subjB.has(t)).sort()
  if (shared.length < MIN_SHARED_SUBJECT) return null

  const opposedOn = opposedClauseOverlap(descA, descB)
  const opposing = opposedOn !== null

  const na = numbersOf(descA)
  const nb = numbersOf(descB)
  const numeric = na.length > 0 && nb.length > 0 && JSON.stringify(na) !== JSON.stringify(nb)

  if (!opposing && !numeric) return null
  // What the operator is shown is what is actually in dispute: the opposed
  // clauses' overlap when polarity is the reason, the claims' overlap when the
  // reason is a quantity.
  return { shared: opposing ? opposedOn : shared, opposing, numeric }
}

/**
 * findContradictions({notes, registry}) — same-subject conflicting pairs of
 * rule-stating kinds (CONTRADICT_KINDS: decision · status · normative ·
 * procedural-rule) with NO supersedes/superseded_by/valid_until linkage
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

      const conflict = detectClaimConflict(claimOf(a), claimOf(b))
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
 * (the citation data) is proposed for episodic→semantic promotion.
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
 * @param {string} [opts.usageDir]  .sma/usage ledger dir (promotion evidence)
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
