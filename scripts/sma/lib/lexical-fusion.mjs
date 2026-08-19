/**
 * lexical-fusion.mjs — how the layers of retrieval become ONE order.
 *
 * The arithmetic that decides which record stands where when more than one way of
 * finding it has an opinion: the facet selection, the exact path/symbol layer and the
 * lexical index. It lived inside the pack compiler while the pack compiler was its only
 * caller. It is here because it now has two — the delivery point and the compiler — and
 * a second copy of an ordering rule is a second retrieval nobody can tell apart from
 * the first. This module is the one place that answer is computed.
 *
 * DELIBERATELY DEPENDENCY-POOR: it imports the lexical layer and nothing else of ours.
 * Not the loader, not the compiler — the compiler already imports the loader, so a
 * single edge back to either would close an import cycle. Everything else it needs
 * (which records exist, which areas they carry, which the hard filters cleared) arrives
 * as arguments, which is also what makes the whole thing testable with a stand-in layer
 * and no database on disk.
 *
 * Node built-ins only; no clock, no randomness, no writes.
 */

import { indexStatus, queryExact, queryLexical, LEXICAL_ENGINES } from './fts-index.mjs'

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
export function diversifyByArea(ranked, areasOf) {
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
export function lexicalLayerOf(injected) {
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
export function fuseLexical({ taskText, corpusDir, now, audience, scope, indexPath, lexical, core, periphery, areasOf, emit }) {
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

