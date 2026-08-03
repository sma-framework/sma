/**
 * context-pack.mjs — the deterministic, budgeted task-pack compiler (9.3-05, D-9.3-07).
 *
 * `sma context "<task>"` assembles a MINIMAL pack — catalog cards + inline fragments +
 * note pointers — under PACK_BUDGET with a MANIFEST. Same input (normalized task text +
 * commit + corpus + catalog) yields BYTE-IDENTICAL PACK.md + MANIFEST.json: no wall-clock,
 * no locale, no machine identity, no randomness anywhere in pack bytes (determinism is the
 * feature — it is what makes pack purity falsifiable, D-9.3-07). The manifest carries the
 * pack's OWN prediction (the session touches no file outside the pack), which is what makes
 * pack purity auto-checkable, and every «context not found in time» miss AUTOMATICALLY grows
 * the repo's memory exam.
 *
 * SUBSTRATE CONSUMED, NEVER RE-IMPLEMENTED (D-9.3-02): notes resolve via loader.mjs
 * resolvePeriphery (injectable), ordering rides generator.mjs makeComparator through the
 * loader, cards via catalog.mjs findCards, citations via the SAME journal (recordCitation);
 * fragment ids flow through that journal so usageStats/deadWeight score facts with zero new
 * machinery. profile.mjs readProfile is the fail-soft consumer of `workingStyle` (pack header)
 * and `stack` (tie-break boost for matching-language cards) — this keeps 9.3-01's schema-v2
 * fields alive under PROFILE-DEADFIELD (scorecard metric 5).
 *
 * TOUCHED-NOT-READ HONESTY: P9.3-05-C measures Edit/Write/Bash TOUCHES (the deterministic
 * observable) as the v1 proxy for «read» — hooking Read would add a spawn per file read and
 * blow the 9.2-02 envelope. Timestamps live ONLY in the touch/exam JOURNALS (.jsonl state),
 * never in the regenerable PACK.md / MANIFEST.json bytes.
 *
 * Node built-ins only; everything DI; no child_process anywhere; zero network; zero LLM.
 */

import { readdirSync, readFileSync, appendFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve as resolvePath, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

import { loadTagsRegistry, resolveAlias, parseNote } from './frontmatter.mjs'
import { resolvePeriphery } from './loader.mjs'
import { projectNoteAxis } from './generator.mjs'
import { findCards } from './catalog.mjs'
import { listFragments, parseTrigger } from './fragments.mjs'
import { PACK_BUDGET } from './constants.mjs'
import { indexStatus, queryExact, queryLexical, LEXICAL_ENGINES } from './fts-index.mjs'
import { estimateTokens } from './economy.mjs'

/** Language token → catalog class family (profile.stack.languages → card boost). */
const LANG_TO_CLASS = {
  js: 'js', javascript: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', python: 'py', rs: 'rs', rust: 'rs', go: 'go', golang: 'go',
}

/**
 * The ONE name for the budget verdict in the reason trace, owned by the stage that
 * makes it (the filters own theirs in generator.mjs, the selection its own in
 * loader.mjs). A consumer reporting «why is this note not in my pack» imports it;
 * a second copy of the word would be a second vocabulary waiting to drift.
 */
export const BUDGET_CUT_REASON = 'budget-cut'

/**
 * The name of the ONE experiment this compiler knows. A string and not a boolean on
 * purpose: the next experiment must be able to be a different value rather than a
 * second flag, and a pack's manifest can then say WHICH experiment produced it.
 */
export const EXPERIMENT_LEXICAL = 'lexical'

/**
 * RRF_K — the smoothing constant of reciprocal-rank fusion, at the value the method was
 * published with. It is what stops rank 1 of a noisy layer from dominating the sum: with
 * k = 60 the gap between rank 1 and rank 2 is a few thousandths, so agreement ACROSS
 * layers outweighs confidence WITHIN one. Exported because a number that decides an
 * order and lives only inside a function is a number nobody can check.
 */
export const RRF_K = 60

/** The layers whose ranks are fused — named, because «matched» is not a reason. */
export const FUSION_LAYERS = Object.freeze({ FACET: 'facet', EXACT: 'exact', LEXICAL: 'lexical' })

/**
 * The ONE word for «the experiment was asked for and could not honestly run». A layer
 * that quietly returns the default answer when its index is stale is the most expensive
 * kind of failure: the measurement then compares the default path against itself and
 * reports no difference, which reads exactly like «the layer does not help».
 */
export const FUSION_DEGRADED_REASON = 'fusion-degraded'

/**
 * Fused scores are rounded before they are compared. Three layers summed in three
 * different orders produce three doubles that differ in the last bit for what is
 * arithmetically the same total — and a tie that exists in the arithmetic but not in the
 * floating point would silently disable the diversity pass. 12 decimals is far below any
 * difference RRF can express (the smallest gap between adjacent ranks here is ~2e-4) and
 * far above the noise of summation order.
 */
const RRF_SCORE_PRECISION = 1e12

/** Min touches for a pack to be «settled» (scorePurity / growExam). */
const SETTLED_MIN_TOUCHES = 3
/** Min settled packs before purity is scored (else the -1 insufficient-data sentinel). */
const PURITY_MIN_PACKS = 5

// ─────────────────────────── task tags + id ─────────────────────────────────

/** Lowercase word tokens (non-word split, empties dropped). */
function tokenize(s) {
  return String(s ?? '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
}

/** Load the tag registry fail-soft (a missing TAGS.md → empty facets). */
function loadRegistrySafe(tagsPath) {
  try {
    return loadTagsRegistry(tagsPath)
  } catch {
    return { area: new Set(), kind: new Set(), aliases: new Map() }
  }
}

/**
 * deriveTaskTags(taskText, registry) → the registered facet tags a task text names,
 * alias-resolved, deduped, sorted. Unknown tokens are ignored (never an over-broad query).
 */
export function deriveTaskTags(taskText, registry) {
  const reg = registry ?? { area: new Set(), kind: new Set(), aliases: new Map() }
  const out = new Set()
  for (const tok of tokenize(taskText)) {
    const t = resolveAlias(tok, reg)
    if (reg.area.has(t) || reg.kind.has(t)) out.add(t)
  }
  return [...out].sort()
}

/** Normalize task text for the identity hash ONLY (the header shows the original). */
function normalizeTask(taskText) {
  return String(taskText ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** packId(taskText, commit) → a stable short sha256 of (normalized task + commit). */
export function packId(taskText, commit) {
  return inputHashOf(taskText, commit).slice(0, 12)
}

/** The full input hash (normalized task + commit). */
function inputHashOf(taskText, commit) {
  return createHash('sha256').update(normalizeTask(taskText) + '\n' + String(commit ?? ''), 'utf8').digest('hex')
}

// ─────────────────────────── note pointer helper ────────────────────────────

/** Collapse to one whitespace-normalized line, capped. */
function oneLine(s, max = 120) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * A per-compile reader of what the ONE axis says about a note: its one-line claim (the
 * pointer text) and its areas (what the diversity pass is allowed to have an opinion
 * about). Read through the SHARED projection, so a schema-v2 record's `claim` fills the
 * same slot a v1 note's `description` does — otherwise every migrated record would enter
 * the pack as a nameless pointer. Fail-soft: an unreadable note is a nameless, arealess
 * one, never a throw. Cached per compile because the fused path asks about the same
 * files twice and a second read is a second chance to disagree.
 */
function noteAxisReader(corpusDir) {
  const cache = new Map()
  return (file) => {
    if (cache.has(file)) return cache.get(file)
    let axis = { description: '', areas: [] }
    if (corpusDir) {
      try {
        const { frontmatter } = parseNote(readFileSync(join(corpusDir, file), 'utf8'), { file })
        if (frontmatter != null) {
          const projected = projectNoteAxis(frontmatter, { file })
          axis = { description: oneLine(projected.description), areas: Array.isArray(projected.tags) ? projected.tags.map(String) : [] }
        }
      } catch {
        /* fail-soft — a pointer without a claim is still a pointer */
      }
    }
    cache.set(file, axis)
    return axis
  }
}

// ─────────────────────────── fusion (EXPERIMENTAL) ──────────────────────────

/**
 * reciprocalRankFusion(lists, {k}) → [{id, score, ranks:[{layer, rank}]}], best first.
 *
 * Ten lines of arithmetic anybody can check by hand: a document's score is the sum, over
 * every layer that ranked it, of 1/(k + rank). No training, no weights to tune, no
 * package — which is the whole reason this method and not a learned one: the layers here
 * return scores on incomparable scales (a BM25 number and a facet position are not the
 * same kind of thing), and RRF is the standard way to combine ORDERS without pretending
 * their scores are commensurable.
 *
 * A document appears ONCE however many layers found it (that is the dedup), and a repeat
 * inside one list is the same document rather than a second chance at a rank. Ties break
 * by id, so two runs of the same inputs cannot disagree.
 *
 * PURE: no I/O, no clock, no randomness.
 *
 * @param {Array<{layer:string, ids:string[]}>} lists
 * @param {{k?:number}} [opts]
 */
export function reciprocalRankFusion(lists, { k = RRF_K } = {}) {
  const kk = Number.isFinite(Number(k)) && Number(k) > 0 ? Number(k) : RRF_K
  const acc = new Map()
  for (const list of Array.isArray(lists) ? lists : []) {
    const layer = String((list && list.layer) ?? '')
    const ids = Array.isArray(list && list.ids) ? list.ids : []
    const seen = new Set()
    for (let i = 0; i < ids.length; i += 1) {
      const id = String(ids[i])
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const rank = seen.size
      const entry = acc.get(id) ?? { id, score: 0, ranks: [] }
      entry.score += 1 / (kk + rank)
      entry.ranks.push({ layer, rank })
      acc.set(id, entry)
    }
  }
  const out = [...acc.values()].map((e) => ({ ...e, score: Math.round(e.score * RRF_SCORE_PRECISION) / RRF_SCORE_PRECISION }))
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * diversifyByArea(ranked, areasOf) — reorder ONLY within runs of equal score.
 *
 * Fusion often produces exact ties (three layers, three rotations of the same handful of
 * documents), and the id order that breaks them is alphabetical, which is no order at
 * all from the reader's side: it clusters a corpus's naming convention, so the top of a
 * pack can be five notes about one area while a second area waits below the budget cut.
 * Among documents the arithmetic cannot separate, this prefers the next one that shares
 * NO area with the one just placed.
 *
 * A DIFFERENT score is never touched: diversity may break a tie, it may not overrule a
 * measurement. Deterministic — the candidate chosen inside a tie is the FIRST qualifying
 * one in the incoming (id) order, and «first» is the same on every machine.
 */
function diversifyByArea(ranked, areasOf) {
  const out = []
  const pool = [...ranked]
  while (pool.length) {
    const score = pool[0].score
    let end = 0
    while (end < pool.length && pool[end].score === score) end += 1
    const group = pool.splice(0, end)
    while (group.length) {
      const previous = out.length ? new Set(areasOf(out[out.length - 1].id)) : null
      let pick = 0
      if (previous && previous.size) {
        const found = group.findIndex((c) => areasOf(c.id).every((area) => !previous.has(area)))
        if (found !== -1) pick = found
      }
      out.push(group.splice(pick, 1)[0])
    }
  }
  return out
}

/** The lexical layer, real unless a caller (a test, an explainer) hands in a double. */
function lexicalLayerOf(injected) {
  const l = injected ?? {}
  return {
    indexStatus: typeof l.indexStatus === 'function' ? l.indexStatus : indexStatus,
    queryExact: typeof l.queryExact === 'function' ? l.queryExact : queryExact,
    queryLexical: typeof l.queryLexical === 'function' ? l.queryLexical : queryLexical,
  }
}

/**
 * fuseLexical(...) → {order, degraded}. The experiment's whole decision, in one place.
 *
 * `order` is the fused list of note ids (null when degraded); `degraded` says the
 * experiment was asked for and could not honestly run — a stale index, or a build of
 * Node whose SQLite the layer never got. Degrading returns the DEFAULT order, and says
 * so in the trace: a silent fallback would make the A/B compare the default path against
 * itself and report the layer as useless.
 *
 * A layer may contribute a document the facet selection never chose. That is the point:
 * the failure class this addresses is «the corpus holds it and the pack does not reach
 * it», and a fusion allowed only to reshuffle what one layer already found could not
 * move it. What it may NOT do is see a record the read-time filters withheld — both
 * queries read the corpus through the same `isVisibleNow` the loader does, and the
 * consumer's filter still stands on top.
 */
function fuseLexical({ taskText, corpusDir, now, audience, scope, indexPath, lexical, core, periphery, areasOf, emit }) {
  const layer = lexicalLayerOf(lexical)
  const visibility = {
    ...(now == null ? {} : { now }),
    ...(audience == null ? {} : { audience }),
    ...(scope == null ? {} : { scope }),
  }

  let status = null
  try {
    status = layer.indexStatus({ corpusDir, dbPath: indexPath, ...visibility })
  } catch {
    status = null
  }
  const engine = status && status.engine ? String(status.engine) : null
  const stale = !status || !status.summary || Number(status.summary.stale) !== 0
  if (engine === LEXICAL_ENGINES.UNAVAILABLE || engine == null || stale) {
    if (emit) {
      emit({
        step: 'fusion',
        verdict: 'degraded',
        reason: FUSION_DEGRADED_REASON,
        detail: {
          engine,
          stale: stale ? 1 : 0,
          index: indexPath ?? null,
          said: status && status.reason ? String(status.reason) : '',
        },
      })
    }
    return { order: null, degraded: true }
  }

  let exactIds = []
  try {
    const res = layer.queryExact({ query: taskText, corpusDir, ...visibility })
    exactIds = (res && Array.isArray(res.results) ? res.results : []).map((r) => String(r && r.id))
  } catch {
    exactIds = []
  }
  let lexicalIds = []
  try {
    const res = layer.queryLexical({ query: taskText, dbPath: indexPath })
    lexicalIds = (res && Array.isArray(res.results) ? res.results : []).map((r) => String(r && r.id))
  } catch {
    lexicalIds = []
  }

  const fused = diversifyByArea(
    reciprocalRankFusion([
      { layer: FUSION_LAYERS.FACET, ids: [...core, ...periphery] },
      { layer: FUSION_LAYERS.EXACT, ids: exactIds },
      { layer: FUSION_LAYERS.LEXICAL, ids: lexicalIds },
    ]),
    (id) => areasOf(id),
  )

  if (emit) {
    for (let i = 0; i < fused.length; i += 1) {
      emit({ step: 'fusion', id: fused[i].id, verdict: 'ranked', detail: { position: i + 1, score: fused[i].score, ranks: fused[i].ranks } })
    }
  }
  return { order: fused.map((e) => e.id), degraded: false }
}

// ─────────────────────────── compile ────────────────────────────────────────

/**
 * compilePack(opts) → {packId, commit, taskText, packMd, manifest, manifestJson, members}.
 * PURE + DETERMINISTIC (no writes, no clock). Priority order (strict prefix under budget):
 *   header → CORE note pointers → periphery note pointers → cards → fragments inline.
 * The header is always the frame; the remaining members fill greedily until the first that
 * would overflow, then iteration STOPS (no backfill — the auditable-prefix property).
 *
 * @param {object} opts
 * @param {string} opts.taskText
 * @param {string} opts.commit
 * @param {string} [opts.corpusDir]
 * @param {string} [opts.tagsPath]
 * @param {object} [opts.dateMap]
 * @param {object} [opts.catalog]   readCatalog() result (or null → zero cards)
 * @param {object} [opts.profile]   normalized profile (or null → no boost/header line)
 * @param {number} [opts.budget]    PACK_BUDGET override
 * @param {Function} [opts.resolve] resolvePeriphery double (default: the real loader)
 * @param {Function} [opts.cite]    (memberId, kind) → recordCitation (packed members only)
 * @param {string|Date} [opts.now]  INJECTED instant for the loader's read-time validity
 *                                  window. Absent → the loader reads the real clock, the
 *                                  behaviour every caller had before. Present → the pack
 *                                  is reproducible on a date other than the one it was
 *                                  compiled on, which is what makes a measurement over
 *                                  it a measurement rather than a snapshot of today.
 * @param {Function|Array} [opts.trace] OPTIONAL reason-trace collector, threaded straight
 *                                  into the loader and extended HERE with the one decision
 *                                  the loader cannot see: the budget cut. Absent — the
 *                                  default — not one event is shaped and the compile is
 *                                  byte-for-byte the compile it always was. The collector
 *                                  OBSERVES: nothing in this function reads it back.
 * @param {string} [opts.experiment] EXPERIMENTAL, and absent by default. `'lexical'`
 *                                  fuses the facet order with the exact and lexical
 *                                  layers by reciprocal rank (RRF_K) and renders the pack
 *                                  in the fused order. Any other value — and the absence
 *                                  of the option, which is every existing caller — leaves
 *                                  the compile byte for byte what it was, and does not
 *                                  ask the lexical layer a single question. This is the
 *                                  whole isolation of the experiment: one option, checked
 *                                  once, and there is no second path through this
 *                                  function for the default pack to drift into.
 * @param {string} [opts.indexPath]  where the derived lexical index lives (under .sma/).
 * @param {object} [opts.lexical]    {indexStatus, queryExact, queryLexical} doubles for
 *                                  the fts-index layer (tests; production passes none).
 */
export function compilePack(opts = {}) {
  const {
    taskText = '',
    commit = '',
    corpusDir,
    tagsPath,
    dateMap = {},
    catalog = null,
    profile = null,
    budget = PACK_BUDGET,
    resolve = resolvePeriphery,
    cite,
    now,
    audience,
    scope,
    trace,
    experiment = null,
    indexPath,
    lexical,
  } = opts

  const emit = typeof trace === 'function' ? trace : Array.isArray(trace) ? (e) => trace.push(e) : null
  const axisOf = noteAxisReader(corpusDir)

  const registry = loadRegistrySafe(tagsPath)
  const tags = deriveTaskTags(taskText, registry)
  const id = packId(taskText, commit)

  // (1) notes — the compiler's ONLY note-retrieval path (consumed, never re-implemented).
  let core = []
  let periphery = []
  try {
    const res =
      resolve({
        tags,
        corpusDir,
        tagsPath,
        dateMap,
        ...(now == null ? {} : { now }),
        // The hard filters have carried an `audience` / `scope` question since they
        // landed, with no caller asking it — a filter class nobody exercises. The
        // explainer is the first caller that must be able to ask «what would an
        // export audience be shown», so the question is threaded here rather than
        // re-asked in a second place. Absent (every existing caller) → unchanged.
        ...(audience == null ? {} : { audience }),
        ...(scope == null ? {} : { scope }),
        ...(trace == null ? {} : { trace }),
      }) || {}
    core = Array.isArray(res.core) ? res.core : []
    periphery = Array.isArray(res.periphery) ? res.periphery : []
  } catch {
    /* fail-soft — a broken resolve yields a pack of cards + fragments only */
  }

  // (2) cards — catalog-before-grep, with a profile-language tie-break boost.
  const boostClasses = new Set()
  if (profile && profile.stack && Array.isArray(profile.stack.languages)) {
    for (const lang of profile.stack.languages) {
      const cls = LANG_TO_CLASS[String(lang).toLowerCase()]
      if (cls) boostClasses.add(cls)
    }
  }
  const cards =
    catalog && catalog.built !== false && Array.isArray(catalog.cards)
      ? findCards({ catalog, query: taskText, boostClasses })
      : []

  // (3) fragments — at COMPILE time only tag-triggers fire (path/cmd are the at-the-act channel).
  const tagSet = new Set(tags)
  const fragments = []
  for (const frag of listFragments({ corpusDir })) {
    if (!frag || !frag.id) continue
    const trig = parseTrigger(frag.trigger)
    if (trig && trig.kind === 'tag' && tagSet.has(resolveAlias(trig.value, registry))) fragments.push(frag)
  }
  fragments.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // (4) profile working-style header line (fail-soft consumer of 9.3-01's field).
  let workingStyleLine = ''
  if (profile && profile.workingStyle && typeof profile.workingStyle === 'object') {
    const parts = Object.keys(profile.workingStyle)
      .sort()
      .filter((k) => profile.workingStyle[k])
      .map((k) => `${k}: ${profile.workingStyle[k]}`)
    if (parts.length) workingStyleLine = parts.join('; ')
  }

  // (4b) the EXPERIMENT, when one was asked for by name. Absent — every existing caller
  // — nothing below changes and the lexical layer is never asked anything at all.
  const fusion =
    experiment === EXPERIMENT_LEXICAL
      ? fuseLexical({ taskText, corpusDir, now, audience, scope, indexPath, lexical, core, periphery, areasOf: (f) => axisOf(f).areas, emit })
      : null
  const fused = Boolean(fusion && !fusion.degraded)

  // (5) build the ordered member list and select a strict priority prefix under budget.
  const headerText = renderHeader({ id, commit, taskText, workingStyleLine })
  const members = [{ type: 'header', id: null, path: null, text: headerText, bytes: Buffer.byteLength(headerText, 'utf8') }]
  const coreSet = new Set(core)
  const noteOrder = fused ? fusion.order.map((file) => ({ file, sub: coreSet.has(file) ? 'core' : 'periphery' })) : [
    ...core.map((file) => ({ file, sub: 'core' })),
    ...periphery.map((file) => ({ file, sub: 'periphery' })),
  ]
  for (const { file, sub } of noteOrder) {
    const desc = axisOf(file).description
    // In the fused pack the two sections collapse into one ORDERED list, so the marker
    // carries what the heading used to: rank is the whole subject of the experiment, and
    // a pack whose rendered order disagreed with the order it was measured in would make
    // the measurement a story about a file nobody reads.
    const text = `- ${fused ? `[${sub === 'core' ? 'core' : 'related'}] ` : ''}${file}${desc ? ` — ${desc}` : ''}`
    members.push({ type: 'note', sub, id: file, path: file, text, bytes: Buffer.byteLength(text, 'utf8') })
  }
  for (const card of cards) {
    const text = JSON.stringify(card)
    members.push({ type: 'card', id: card.path, path: card.path, text, bytes: Buffer.byteLength(text, 'utf8') })
  }
  for (const frag of fragments) {
    const text = frag.body
    members.push({ type: 'fragment', id: frag.id, path: frag.file, text, bytes: Buffer.byteLength(text, 'utf8') })
  }

  // header always included (the frame); the rest fill greedily until the first overflow.
  const included = [members[0]]
  let running = members[0].bytes
  for (let i = 1; i < members.length; i++) {
    const b = members[i].bytes + 1 // + newline
    if (running + b > budget) break // strict prefix — no backfill (auditable-prefix property)
    included.push(members[i])
    running += b
  }

  // (5b) the budget verdict, when somebody is collecting a reason trace. A note the
  // loader SELECTED and the budget then cut is not «missing» — it lost a place in a
  // strict priority prefix, at a nameable position, against a nameable ceiling. That
  // distinction is the whole difference between a retrieval bug and an economy one.
  if (emit) {
    for (let i = included.length; i < members.length; i++) {
      const m = members[i]
      if (m.type !== 'note') continue
      emit({
        step: 'budget',
        id: m.id,
        verdict: 'rejected',
        reason: BUDGET_CUT_REASON,
        detail: { position: i, bytes: m.bytes, budget, used: running },
      })
    }
    for (let i = 1; i < included.length; i++) {
      const m = included[i]
      if (m.type === 'note') emit({ step: 'budget', id: m.id, verdict: 'within-budget', detail: { position: i } })
    }
  }

  // (6) cite ONLY the packed notes + fragments (kind 'load') — packed, not merely resolved.
  if (typeof cite === 'function') {
    for (const m of included) {
      if (m.type === 'note' || m.type === 'fragment') {
        try {
          cite(m.id, 'load')
        } catch {
          /* fail-open — a citation never breaks the compile */
        }
      }
    }
  }

  const packMd = renderPack({ header: included[0], members: included, fused })
  const files = []
  const seenPath = new Set()
  const manifestMembers = []
  for (const m of included) {
    if (m.type === 'header') continue
    manifestMembers.push({ type: m.type, id: m.id, path: m.path, bytes: m.bytes })
    if (m.path && !seenPath.has(m.path)) {
      seenPath.add(m.path)
      files.push(m.path)
    }
  }
  const manifest = {
    packId: id,
    v: 1,
    commit: String(commit),
    inputHash: inputHashOf(taskText, commit),
    task: String(taskText),
    budget,
    bytes: Buffer.byteLength(packMd, 'utf8'),
    members: manifestMembers,
    files,
    prediction: { claim: 'session touches no file outside files[]', metric: 'pack_purity' },
  }
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n'

  return { packId: id, commit: String(commit), taskText: String(taskText), tags, packMd, manifest, manifestJson, members: included }
}

/** renderHeader — the pack frame (packId, commit, task, optional working-style line). */
function renderHeader({ id, commit, taskText, workingStyleLine }) {
  const lines = [
    `# Context pack ${id}`,
    '',
    `- commit: ${commit}`,
    `- task: ${oneLine(taskText, 400)}`,
  ]
  if (workingStyleLine) lines.push(`- style: ${oneLine(workingStyleLine, 200)}`)
  return lines.join('\n')
}

/**
 * renderPack({header, members, fused}) → the PACK.md string. Sections render ONLY when
 * they carry included members, in the fixed order core → periphery → cards → fragments.
 * Deterministic (no clock, no randomness). Exported so the CLI + selftest reuse it.
 *
 * `fused` (the experiment only) renders the notes as ONE ranked list instead of two
 * sections, each line marked with the provenance the heading used to carry. The split
 * core/periphery is still explicit — per line rather than per section — and the order on
 * the page is then the order the pack was measured in, which two sections could not be.
 */
export function renderPack({ header, members = [], fused = false }) {
  const notes = members.filter((m) => m.type === 'note')
  const coreP = notes.filter((m) => m.sub === 'core')
  const periP = notes.filter((m) => m.sub !== 'core')
  const cards = members.filter((m) => m.type === 'card')
  const frags = members.filter((m) => m.type === 'fragment')

  const out = [header && header.text ? header.text : '']
  if (fused) {
    if (notes.length) {
      out.push('', '## Notes (fused ranking)')
      for (const m of notes) out.push(m.text)
    }
  } else {
    if (coreP.length) {
      out.push('', '## Core notes')
      for (const m of coreP) out.push(m.text)
    }
    if (periP.length) {
      out.push('', '## Related notes')
      for (const m of periP) out.push(m.text)
    }
  }
  if (cards.length) {
    out.push('', '## Files (catalog cards)')
    for (const m of cards) out.push(m.text)
  }
  if (frags.length) {
    out.push('', '## Facts')
    for (const m of frags) out.push(m.text)
  }
  return out.join('\n') + '\n'
}

// ─────────────────────────── purity + exam growth ───────────────────────────

/** Normalize a touched/manifest path to repo-relative forward slashes. */
function normPath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Read a .jsonl file tolerantly → parsed objects (corrupt lines skipped). */
function readJsonl(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of String(raw).split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* skip corrupt line (fail-open) */
    }
  }
  return out
}

/** List every settled pack: {packId, manifest, touches, outside[]}. */
function settledPacks(contextDir) {
  const packsDir = join(contextDir, 'packs')
  let dirs
  try {
    dirs = readdirSync(packsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return []
  }
  const out = []
  for (const name of dirs) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(packsDir, name, 'MANIFEST.json'), 'utf8'))
    } catch {
      continue
    }
    const touches = readJsonl(join(packsDir, name, 'touched.jsonl'))
    if (touches.length < SETTLED_MIN_TOUCHES) continue
    const fileSet = new Set((manifest.files ?? []).map(normPath))
    const outside = []
    for (const t of touches) {
      const p = normPath(t && t.path)
      if (p && !fileSet.has(p)) outside.push(p)
    }
    out.push({ packId: manifest.packId ?? name, manifest, touches, outside })
  }
  return out
}

/**
 * scorePurity({contextDir}) → {purityPct, settledPacks, outside[]}. Counts only packs
 * with >= 3 touches; fewer than 5 settled packs → purityPct -1 (explicit insufficient-data
 * sentinel — never a fabricated pass). purityPct = inside-touches / total-touches across
 * settled packs (0-100, rounded).
 */
export function scorePurity({ contextDir } = {}) {
  const packs = settledPacks(contextDir)
  let inside = 0
  let total = 0
  const outside = []
  for (const p of packs) {
    total += p.touches.length
    inside += p.touches.length - p.outside.length
    for (const o of p.outside) outside.push({ packId: p.packId, path: o })
  }
  if (packs.length < PURITY_MIN_PACKS) return { purityPct: -1, settledPacks: packs.length, outside }
  const purityPct = total > 0 ? Math.round((inside / total) * 100) : 0
  return { purityPct, settledPacks: packs.length, outside }
}

/** Dedup key for an exam question. */
function examKey(q) {
  return JSON.stringify([String(q.query ?? ''), String(q.expected ?? '')])
}

/**
 * growExam({contextDir}) → {added, total}. Converts every settled pack's outside-pack
 * touches into exam lines {query: pack task text, expected: missed path}, appended to
 * `<contextDir>/exam.jsonl` (dedup on query+expected, append-only). A context failure
 * becomes a standing question — never a shrug (D-9.3-07).
 */
export function growExam({ contextDir } = {}) {
  const examPath = join(contextDir, 'exam.jsonl')
  const existing = new Set(readJsonl(examPath).map(examKey))
  const toAdd = []
  for (const p of settledPacks(contextDir)) {
    const query = String((p.manifest && p.manifest.task) ?? '')
    for (const expected of p.outside) {
      const q = { query, expected, kind: 'auto' }
      const k = examKey(q)
      if (existing.has(k)) continue
      existing.add(k)
      toAdd.push(q)
    }
  }
  if (toAdd.length) {
    mkdirSync(contextDir, { recursive: true })
    appendFileSync(examPath, toAdd.map((q) => JSON.stringify(q)).join('\n') + '\n')
  }
  return { added: toAdd.length, total: existing.size }
}

// ─────────────────────────── note-level gold cases ──────────────────────────

/**
 * A NOTE-level gold case — the retrieval-recall unit of the measurement baseline:
 *   {task, expected_notes[], critical_notes[], forbidden_notes[]}
 *
 * WHY A SEPARATE SCORER, NOT AN EXTENDED runExam: the exam harness above is a
 * FILE-level pass/fail counter over a growing question log — its case model is one
 * {query, expected} pair per line, its ground truth is the manifest's files[] (notes,
 * cards AND fragment files together), and its {count,total,failures} return is what
 * the CLI's exam replay prints. A gold case asks a different question — which NOTES
 * arrive, which of them are critical, and which must NOT arrive — and needs the
 * core/periphery split that files[] deliberately flattens. Widening runExam's return
 * would have bent an existing consumer's contract for a second purpose; this helper
 * sits beside it and reuses the same substrate instead.
 *
 * GROUND TRUTH IS THE REAL LOADER: the loaded set comes from compilePack — task text
 * → deriveTaskTags → resolvePeriphery (generator CORE rule + tag-matched periphery)
 * → budget prefix. Nothing about «what loads» is re-derived here, so the score can
 * never drift from the behavior it claims to measure.
 *
 * THE GRAMMAR GROWS ADDITIVELY (V5.2). The canon asks a gold case four more questions
 * than the four fields above; every one of them is an OPTIONAL key, so a case file
 * written before this paragraph existed scores byte-for-byte as it always did — which
 * is not politeness, it is the re-measurement protocol: a baseline whose input format
 * shifted underneath it is a story, not a comparison.
 *
 *   class            the named test class this case belongs to (reported, never scored)
 *   schema_version   the case grammar the line was written against (default 1)
 *   expected_action  what a correct consumer should DO with the retrieved set — carried
 *                    and reported here, judged by the action-impact tier, not by this
 *                    function (it scores retrieval, and says so)
 *   should_abstain   the RIGHT answer is an empty selection. Scored against the SELECTED
 *                    set — the notes retrieval CHOSE — never against unconditional CORE,
 *                    which arrives for every task and would make abstention impossible to
 *                    express. Reported as its own verdict (`abstain: pass|fail`) precisely
 *                    so «held back correctly» can never be read as «missed something».
 *   repo_state       a POSIX-relative path, from the DIRECTORY OF THE CASE FILE, to a
 *                    fixture corpus this one case scores against instead of the default.
 *
 * CONTAMINATION IS REFUSED, NOT SCORED: adversarial fixtures (poisoned memory, prompt
 * injection, a foreign repo's notes) exist to be retrieved AT the system, and the one
 * place they must never live is the live corpus that answers real questions. A
 * `repo_state` that resolves into the corpus directory — or an absolute path, or a path
 * that does not exist — yields a case-level `error` and is left OUT of the score
 * entirely. A refused case is not a miss and not a hit: pretending otherwise would let a
 * broken fixture quietly move the number the benchmark exists to protect.
 */

/** Unique + sorted (stable report bytes regardless of input order). */
function uniqSorted(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((s) => String(s)))].sort()
}

/** True when `child` is `parent` itself or lives underneath it. */
function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * resolveRepoState(repoState, {casesDir, corpusDir}) → {dir} or {error}.
 *
 * The gate described in the block comment above, in one place so both the scorer and
 * its tests read the same rule. Error codes are stable strings (they end up in a
 * report): `repo-state-not-relative`, `repo-state-unresolvable`,
 * `repo-state-contamination`, `repo-state-missing`.
 */
function resolveRepoState(repoState, { casesDir, corpusDir } = {}) {
  const raw = String(repoState ?? '').trim()
  // POSIX-relative only: a backslash or a drive letter is a machine-specific path, and
  // a case file that only works on the machine that wrote it is not a gold case.
  if (raw.includes('\\') || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return { error: 'repo-state-not-relative' }
  if (!casesDir) return { error: 'repo-state-unresolvable' }
  const dir = resolvePath(casesDir, raw)
  if (corpusDir && isInside(resolvePath(corpusDir), dir)) return { error: 'repo-state-contamination' }
  let ok = false
  try {
    ok = existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    ok = false
  }
  return ok ? { dir } : { error: 'repo-state-missing' }
}

/**
 * scoreNoteCases(opts) → {coreLoaded, cases[], totals}. PURE over its inputs (reads the
 * corpus, writes nothing, no clock, no randomness): the same corpus + the same cases
 * always produce the identical object.
 *
 * Per case: {task, class, schemaVersion, expectedAction, corpusDir, loaded, selected,
 *            expected, hits, missing, criticalMissing, forbiddenPresent, abstain, error?}
 *   - corpusDir       the corpus this case was scored AGAINST (the default one, or the
 *                     fixture a `repo_state` case named) — so a consumer never has to
 *                     resolve a fixture path a second time; `null` on a refused case
 *   - loaded          the note files that actually arrived in the pack, in pack order
 *   - selected        the subset retrieval CHOSE (periphery) — `loaded` minus the
 *                     unconditional CORE frame; the set an abstention case is judged by
 *   - hits/missing    expected_notes split by presence in `loaded`
 *   - criticalMissing critical_notes absent from `loaded` (scored independently of
 *                     expected_notes — a critical note is critical whether or not the
 *                     case bothered to list it twice)
 *   - forbiddenPresent forbidden_notes that loaded anyway
 *   - abstain         'pass' (should_abstain and selected nothing) | 'fail' | null
 *   - error           present ONLY on a refused case (see the block comment): every
 *                     score field is empty and the case is excluded from the totals
 * A case with no `task` string is skipped (never a fabricated score); non-array note
 * fields degrade to [] rather than throwing.
 *
 * @param {object} opts
 * @param {object[]} opts.cases     gold cases (see the block comment above)
 * @param {string} [opts.corpusDir]
 * @param {string} [opts.casesDir]  directory of the case FILE — the base a case's
 *                                  `repo_state` fixture path resolves against
 * @param {string} [opts.tagsPath]
 * @param {object} [opts.dateMap]
 * @param {string} [opts.commit]    injected (affects packId only, never the score)
 * @param {number} [opts.budget]
 * @param {object} [opts.catalog]
 * @param {object} [opts.profile]
 * @param {string|Date} [opts.now]  INJECTED instant for the read-time validity window
 *                                  (threaded straight to compilePack). A scorer that
 *                                  reads the wall clock stops being a pure function of
 *                                  the corpus, and a gold set scored against «today»
 *                                  changes its answer without anything changing.
 * @param {Function} [opts.resolve] resolvePeriphery double
 * @param {Function} [opts.compile] (taskText) → a compilePack result (default: the real one)
 */
export function scoreNoteCases(opts = {}) {
  const {
    cases = [],
    corpusDir,
    casesDir,
    tagsPath,
    dateMap = {},
    commit = '',
    budget = PACK_BUDGET,
    catalog = null,
    profile = null,
    now,
    resolve = resolvePeriphery,
    compile,
    experiment = null,
    indexPath,
    lexical,
  } = opts

  // One compile per case, told WHICH corpus to read: the default one, or the fixture a
  // `repo_state` case names. An injected double receives the same context object, so a
  // test can assert which corpus a case was scored against.
  //
  // The EXPERIMENT is threaded, not re-implemented: the A/B's two arms differ by this
  // one option and nothing else, which is what makes the difference between the two
  // numbers attributable to the layer rather than to two code paths.
  const compileOne =
    typeof compile === 'function'
      ? compile
      : (taskText, ctx = {}) =>
          compilePack({
            taskText,
            commit,
            corpusDir: ctx.corpusDir ?? corpusDir,
            tagsPath: ctx.tagsPath ?? tagsPath,
            dateMap,
            catalog,
            profile,
            budget,
            resolve,
            ...(now == null ? {} : { now }),
            ...(experiment == null ? {} : { experiment }),
            ...(indexPath == null ? {} : { indexPath }),
            ...(lexical == null ? {} : { lexical }),
          })

  const coreLoaded = new Set()
  const scored = []
  let scoredCases = 0
  let expectedTotal = 0
  let hitTotal = 0
  let missingTotal = 0
  let criticalMissingTotal = 0
  let casesWithCriticalMiss = 0
  let forbiddenPresentTotal = 0
  let abstainPass = 0
  let abstainFail = 0
  let rejected = 0
  let loadedTotal = 0
  let packBytesTotal = 0
  let packTokensTotal = 0

  for (const gold of Array.isArray(cases) ? cases : []) {
    if (!gold || typeof gold.task !== 'string' || gold.task.trim() === '') continue

    // ── the optional canon keys (absent → the pre-extension reading, exactly) ──
    const klass = typeof gold.class === 'string' && gold.class.trim() !== '' ? gold.class.trim() : null
    const schemaVersion = Number.isFinite(Number(gold.schema_version)) ? Number(gold.schema_version) : 1
    const expectedAction =
      typeof gold.expected_action === 'string' && gold.expected_action.trim() !== '' ? gold.expected_action.trim() : null
    const shouldAbstain = gold.should_abstain === true
    const head = { task: gold.task, class: klass, schemaVersion, expectedAction }

    // ── which corpus does THIS case ask about ──
    let caseCorpusDir = corpusDir
    let caseTagsPath = tagsPath
    const repoState = typeof gold.repo_state === 'string' ? gold.repo_state.trim() : ''
    if (repoState !== '') {
      const resolved = resolveRepoState(repoState, { casesDir, corpusDir })
      if (resolved.error) {
        rejected += 1
        scored.push({
          ...head,
          error: resolved.error,
          repoState,
          corpusDir: null,
          loaded: [],
          selected: [],
          expected: [],
          hits: [],
          missing: [],
          criticalMissing: [],
          forbiddenPresent: [],
          abstain: null,
        })
        continue
      }
      caseCorpusDir = resolved.dir
      caseTagsPath = join(resolved.dir, 'TAGS.md')
    }

    let packMembers = []
    let packBytes = 0
    let packTokens = 0
    try {
      const res = compileOne(gold.task, { corpusDir: caseCorpusDir, tagsPath: caseTagsPath })
      packMembers = res && Array.isArray(res.members) ? res.members : []
      // What the pack COST to deliver, carried beside what it got right. A retrieval
      // number without the size of the payload that produced it can be improved by
      // simply sending more, which is the cheapest way to look better at the reader's
      // expense. Tokens come from the ONE estimator the product prices context with
      // (economy.mjs, ESTIMATOR_VERSION) — a second rule of thumb here would be a second
      // price for the same pack. An injected compile double reporting no pack costs 0.
      packBytes = res && res.manifest && Number.isFinite(Number(res.manifest.bytes)) ? Number(res.manifest.bytes) : 0
      packTokens = res && typeof res.packMd === 'string' ? estimateTokens(res.packMd) : 0
    } catch {
      packMembers = [] // fail-soft — a broken compile scores as «nothing loaded», never a throw
      packBytes = 0
      packTokens = 0
    }
    const notes = packMembers.filter((m) => m && m.type === 'note')
    const loaded = notes.map((m) => String(m.id))
    const loadedSet = new Set(loaded)
    // The SELECTED set: what retrieval chose, with the unconditional frame removed.
    const selected = notes.filter((m) => m.sub !== 'core').map((m) => String(m.id))
    // The always-load set of the DEFAULT corpus only — a fixture's core is that
    // fixture's business and must not be reported as the corpus's own frame.
    if (caseCorpusDir === corpusDir) for (const m of notes) if (m.sub === 'core') coreLoaded.add(String(m.id))

    const expected = uniqSorted(gold.expected_notes)
    const critical = uniqSorted(gold.critical_notes)
    const forbidden = uniqSorted(gold.forbidden_notes)

    const hits = expected.filter((f) => loadedSet.has(f))
    const missing = expected.filter((f) => !loadedSet.has(f))
    const criticalMissing = critical.filter((f) => !loadedSet.has(f))
    const forbiddenPresent = forbidden.filter((f) => loadedSet.has(f))
    const abstain = shouldAbstain ? (selected.length === 0 ? 'pass' : 'fail') : null

    scoredCases += 1
    expectedTotal += expected.length
    hitTotal += hits.length
    missingTotal += missing.length
    criticalMissingTotal += criticalMissing.length
    if (criticalMissing.length) casesWithCriticalMiss += 1
    forbiddenPresentTotal += forbiddenPresent.length
    if (abstain === 'pass') abstainPass += 1
    if (abstain === 'fail') abstainFail += 1
    loadedTotal += loaded.length
    packBytesTotal += packBytes
    packTokensTotal += packTokens

    // `corpusDir` is reported per case because a `repo_state` case is scored against a
    // FIXTURE corpus, and a consumer that needs what that corpus states about itself
    // (a record's retirement, a declared contradiction) would otherwise have to resolve
    // the fixture path a second time — re-implementing the contamination gate, which is
    // the one thing resolveRepoState exists to be the only copy of.
    scored.push({ ...head, corpusDir: caseCorpusDir ?? null, loaded, selected, expected, hits, missing, criticalMissing, forbiddenPresent, abstain, packBytes, packTokens })
  }

  return {
    coreLoaded: [...coreLoaded].sort(),
    cases: scored,
    totals: {
      cases: scoredCases,
      expected: expectedTotal,
      hits: hitTotal,
      missing: missingTotal,
      criticalMissing: criticalMissingTotal,
      casesWithCriticalMiss,
      forbiddenPresent: forbiddenPresentTotal,
      abstainPass,
      abstainFail,
      rejected,
      loaded: loadedTotal,
      packBytes: packBytesTotal,
      packTokens: packTokensTotal,
    },
  }
}

/**
 * appendMiss({query, expected, contextDir}) → {added}. Records a manual «not found in
 * time» case as an exam question (dedup on query+expected, append-only).
 */
export function appendMiss({ query, expected, contextDir } = {}) {
  const examPath = join(contextDir, 'exam.jsonl')
  const existing = new Set(readJsonl(examPath).map(examKey))
  const q = { query: String(query ?? ''), expected: normPath(expected), kind: 'manual' }
  if (existing.has(examKey(q))) return { added: 0 }
  mkdirSync(contextDir, { recursive: true })
  appendFileSync(examPath, JSON.stringify(q) + '\n')
  return { added: 1 }
}

/**
 * runExam({contextDir, compile}) → {count, total, failures[]}. Replays every exam question
 * through the injected compile(query) → manifest; a question whose `expected` member is
 * ABSENT from the manifest's files[] counts as a failure. Corrupt exam lines are skipped
 * tolerantly, never fatal.
 */
export function runExam({ contextDir, compile } = {}) {
  const questions = readJsonl(join(contextDir, 'exam.jsonl'))
  const failures = []
  for (const q of questions) {
    if (!q || typeof q.query !== 'string' || typeof q.expected !== 'string') continue
    let files = []
    try {
      const manifest = compile(q.query)
      files = manifest && Array.isArray(manifest.files) ? manifest.files.map(normPath) : []
    } catch {
      files = []
    }
    if (!files.includes(normPath(q.expected))) failures.push(q)
  }
  return { count: failures.length, total: questions.length, failures }
}
