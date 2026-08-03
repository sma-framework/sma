/**
 * memory-explain.mjs — the REASON TRACE of retrieval (canon §6: explainability lands
 * BEFORE any new retrieval layer).
 *
 * For one task, this module says of EVERY note in the corpus either «it arrived, on
 * these grounds» or «it was dropped, by this filter, over this field». That is the
 * difference between a retrieval layer you can debug and one you can only believe: a
 * next retriever that changes the numbers must also be able to show WHICH decisions it
 * changed, and there is no honest way to A/B two selections whose reasons are invisible.
 *
 * IT EXPLAINS THE REAL SELECTION, AND ONLY THAT. The verdicts come from a trace
 * collector threaded through the actual `compilePack` → `resolvePeriphery` path: the
 * hard filters (generator.mjs `visibilityVerdict`), CORE membership and facet matching
 * (loader.mjs), and the strict budget prefix (context-pack.mjs) each report the decision
 * they themselves made. There is NO selection logic in this file — not a filter, not a
 * comparator, not a threshold. A second implementation would explain a retrieval nobody
 * runs, which is worse than no explanation at all, because it would be believed.
 *
 * ONE VOCABULARY, OWNED WHERE IT IS DECIDED. Every reason code is IMPORTED from the
 * stage that issues it (VISIBILITY_REASONS · SELECTION_BASES · BUDGET_CUT_REASON) and
 * merely re-exported here as one frozen map for consumers. The trace event shape —
 * `{step, verdict, detail}`, summarizable as `step:verdict` — is deliberately the shape
 * the write pipeline's step-10 retrieval trace already uses, so the two journals read
 * the same way instead of teaching two grammars for the same idea.
 *
 * ACCOUNTING IS THE POINT: `selected ∪ rejected` must cover the corpus, and
 * `unaccounted` must be empty. A note that appears in NEITHER list is the failure mode
 * this module exists to make visible — silence about a record is exactly how a memory
 * layer loses one. A file the parser cannot read is not silently skipped either: it is
 * rejected as `unparsed`, because retrieval genuinely cannot see it and the corpus's
 * owner deserves to know that from the explainer, not only from the lint.
 *
 * PURE over its inputs: reads a corpus, writes nothing, and takes its instant by
 * injection. Node built-ins only; zero deps, zero LLM, zero network.
 */

import { join } from 'node:path'

import { compilePack, BUDGET_CUT_REASON } from './context-pack.mjs'
import { SELECTION_BASES } from './loader.mjs'
import { listNoteFiles, readNotes, VISIBILITY_REASONS } from './generator.mjs'

/** A corpus file whose frontmatter retrieval cannot parse — invisible to the loader. */
const UNPARSED_REASON = 'unparsed'

/**
 * EXPLAIN_REASONS — the frozen vocabulary of verdicts, assembled from the stages that
 * own them. Nothing is typed twice here: rename a reason at its source and this map
 * follows, which is the only way a dictionary and the code it describes stay in step.
 */
export const EXPLAIN_REASONS = Object.freeze({
  // ── selection bases (loader.mjs) ──
  CORE: SELECTION_BASES.CORE, // the record STATES it always loads
  WEIGHT: SELECTION_BASES.WEIGHT, // its number carried it over the CORE floor
  TAG: SELECTION_BASES.TAG, // reported as `tag:<name>` — the tag is part of the answer
  UNCONSTRAINED: SELECTION_BASES.UNCONSTRAINED, // the query named no registered facet
  // ── rejections: hard filters (generator.mjs), matching (loader.mjs), budget ──
  STATUS_RETIRED: VISIBILITY_REASONS.STATUS_RETIRED,
  NOT_YET_VALID: VISIBILITY_REASONS.NOT_YET_VALID,
  EXPIRED: VISIBILITY_REASONS.EXPIRED,
  SENSITIVITY_CEILING: VISIBILITY_REASONS.SENSITIVITY_CEILING,
  SCOPE_REPO: VISIBILITY_REASONS.SCOPE_REPO,
  SCOPE_ENVIRONMENT: VISIBILITY_REASONS.SCOPE_ENVIRONMENT,
  NO_TAG_OVERLAP: SELECTION_BASES.NO_TAG_OVERLAP,
  BUDGET_CUT: BUDGET_CUT_REASON,
  UNPARSED: UNPARSED_REASON,
})

/** The stage order a note's story is told in — used only to sort a stable report. */
const STEP_ORDER = ['visibility', 'match', 'membership', 'budget', 'corpus']

/** Stable string compare (never locale-dependent — report bytes must reproduce). */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * reduceTrace(events) → Map(id → verdict record).
 *
 * The rule, stated once: A REJECTION IS FINAL. A record can be selected by the loader
 * and then cut by the budget; it can never travel the other way, because every stage
 * only ever sees what the previous one passed on. So any rejection wins, whenever it
 * arrives, and a selection stands only if nothing later refused it. `within-budget` is
 * not a verdict of its own — it carries the pack POSITION onto a verdict already made,
 * which is why it must never overwrite the grounds the note was selected on.
 */
function reduceTrace(events) {
  const out = new Map()
  for (const e of events) {
    if (!e || typeof e.id !== 'string') continue
    const current = out.get(e.id)

    if (e.verdict === 'rejected') {
      out.set(e.id, {
        id: e.id,
        verdict: 'rejected',
        step: e.step,
        reason: e.reason,
        detail: e.detail ?? {},
        // a note the loader chose and the budget then cut keeps the grounds it was
        // chosen on: «it qualified, it did not fit» is a different fact from «it never
        // qualified», and collapsing the two hides where the fix belongs
        ...(current && current.verdict === 'selected' ? { qualified_as: current.basis } : {}),
      })
      continue
    }

    if (e.verdict === 'within-budget') {
      if (current && current.verdict === 'selected') current.position = e.detail?.position ?? null
      continue
    }

    if (e.verdict === 'selected' && (!current || current.verdict !== 'rejected')) {
      out.set(e.id, { id: e.id, verdict: 'selected', step: e.step, basis: e.basis, detail: e.detail ?? {}, position: null })
    }
  }
  return out
}

/**
 * explainRetrieval(opts) → the per-note verdict report for one task.
 *
 * Report:
 *   {task, tags, corpus_dir, budget, selected[], rejected[], unaccounted[], by_reason[],
 *    summary{…}}
 *   - selected  [{id, basis, position, step, detail}] in PACK ORDER — the order the
 *               reader meets them in, which is what makes «why is this one twelfth» an
 *               answerable question
 *   - rejected  [{id, reason, step, detail, qualified_as?}] grouped-stable by reason
 *   - unaccounted the notes that received NO verdict — must be empty; it is reported
 *               rather than asserted, because an explainer that hides its own gap is
 *               the failure it was written to catch
 *
 * @param {object} opts
 * @param {string} opts.task           the task text (alias: `taskText`)
 * @param {string} opts.corpusDir
 * @param {string} [opts.tagsPath]     defaults to <corpusDir>/TAGS.md
 * @param {string|Date} [opts.now]     INJECTED instant for the read-time filters
 * @param {string} [opts.audience]     consumer class (default: the local owner)
 * @param {{repo?:string, environment?:string}} [opts.scope]
 * @param {number} [opts.budget]       pack budget override
 * @param {object} [opts.dateMap]      file → last-commit ISO (ordering only)
 * @param {string} [opts.commit]       INJECTED (pack identity only, never a verdict)
 * @param {Function} [opts.compile]    compilePack double (tests)
 * @returns {object}
 */
export function explainRetrieval(opts = {}) {
  const {
    task,
    taskText,
    corpusDir,
    tagsPath,
    now,
    audience,
    scope,
    budget,
    dateMap = {},
    commit = '',
    compile,
  } = opts

  const text = String(taskText ?? task ?? '')
  const resolvedTagsPath = tagsPath ?? (corpusDir ? join(corpusDir, 'TAGS.md') : undefined)

  // ── run the REAL compile with a collector attached ─────────────────────────
  const events = []
  const pack = (typeof compile === 'function' ? compile : compilePack)({
    taskText: text,
    commit,
    corpusDir,
    tagsPath: resolvedTagsPath,
    dateMap,
    trace: events,
    ...(now == null ? {} : { now }),
    ...(audience == null ? {} : { audience }),
    ...(scope == null ? {} : { scope }),
    ...(budget == null ? {} : { budget }),
  })

  const verdicts = reduceTrace(events)

  // ── accounting: ask the corpus itself who should have had a verdict ────────
  // Both lists come from the module that owns the corpus walk — the explainer never
  // decides for itself what counts as a note (that would be a second answer to a
  // question the loader already answers, and the two would drift on the first
  // structural file somebody adds).
  const everyFile = listNoteFiles(corpusDir)
  const readable = new Set(readNotes(corpusDir).map((n) => n.file))
  for (const file of everyFile) {
    if (readable.has(file) || verdicts.has(file)) continue
    verdicts.set(file, {
      id: file,
      verdict: 'rejected',
      step: 'corpus',
      reason: UNPARSED_REASON,
      detail: { field: 'frontmatter', value: null },
    })
  }
  const unaccounted = everyFile.filter((f) => !verdicts.has(f)).sort(cmp)

  const selected = [...verdicts.values()]
    .filter((v) => v.verdict === 'selected')
    .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || cmp(a.id, b.id))
  const rejected = [...verdicts.values()]
    .filter((v) => v.verdict === 'rejected')
    .sort((a, b) => cmp(String(a.reason), String(b.reason)) || cmp(a.id, b.id))

  const byReason = new Map()
  for (const r of rejected) {
    const key = String(r.reason)
    if (!byReason.has(key)) byReason.set(key, { reason: key, step: r.step, count: 0, notes: [] })
    const bucket = byReason.get(key)
    bucket.count += 1
    bucket.notes.push(r.id)
  }

  const count = (reason) => rejected.filter((r) => r.reason === reason).length
  const hardFiltered = Object.values(VISIBILITY_REASONS).reduce((n, reason) => n + count(reason), 0)

  return {
    metric: 'memory-explain',
    task: text,
    tags: pack && Array.isArray(pack.tags) ? pack.tags : [],
    corpus_dir: corpusDir ?? null,
    budget: budget ?? (pack && pack.manifest ? pack.manifest.budget : null),
    selected,
    rejected,
    unaccounted,
    by_reason: [...byReason.values()].sort((a, b) => cmp(a.reason, b.reason) || cmp(String(a.step), String(b.step))),
    summary: {
      corpus_total: everyFile.length,
      selected_count: selected.length,
      rejected_count: rejected.length,
      unaccounted: unaccounted.length,
      hard_filtered: hardFiltered,
      no_tag_overlap: count(SELECTION_BASES.NO_TAG_OVERLAP),
      budget_cut: count(BUDGET_CUT_REASON),
      unparsed: count(UNPARSED_REASON),
    },
  }
}

/** The trace step order, exported so a renderer groups the story the way it happened. */
export const EXPLAIN_STEPS = Object.freeze([...STEP_ORDER])
