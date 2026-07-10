/**
 * model-version.mjs — the Claude-model sighting timeline + stale-priors guard
 * (49.3-02, D-49.3-10, grill missing-leaps ICE 567).
 *
 * The calibration passport publishes a public hit-rate badge. The moment the
 * underlying Claude model changes, the historical priors are about a DIFFERENT
 * model — continuing to headline the old hit-rate would be statistical
 * dishonesty. This module gives the passport the two things it needs to stay
 * honest across a model swap:
 *
 *   1. A DATA FEED — recordModelSighting appends an append-only, deduped
 *      timeline of which model produced work (sightings.jsonl), written from
 *      the session-start hook (fail-open) and stamped onto every predict-score
 *      ledger record (stampRecords) so each future verdict knows its model.
 *   2. The GUARD MATH — modelGuard turns {timeline, records} into a status
 *      ('ok' | 'stale-priors' | 'no-model-data') plus the count of UNIQUE
 *      predictions whose LATEST hit/miss verdict is fresh under the current
 *      model (latestVerdictPerPrediction — re-scores never inflate n).
 *      renderBadgeBlock (passport.mjs) hides the hit-rate claim until that
 *      count crosses BADGE_MIN_N.
 *
 * `records` fed to modelGuard are calibration-ledger records for PREDICTION
 * domains only — the CALLER (passport.buildSnapshot) filters out sma.receipts,
 * because mixing receipt verdicts into the prediction-calibration claim is
 * exactly the dishonesty the badge guard exists to kill.
 *
 * Structure mirrors calibration.mjs / journal.mjs: append-only JSONL, tolerant
 * skip-and-count reader, missing dir -> honest empty, fail-open everywhere
 * (substrate law C9 — a telemetry bug can never break a session). Node built-ins
 * only; every fs seam is dependency-injectable so tests never touch real .sma/.
 */

import {
  readFileSync as fsReadFileSync,
  appendFileSync as fsAppendFileSync,
  mkdirSync as fsMkdirSync,
} from 'node:fs'
import { join } from 'node:path'

import { MODEL_DIR } from './constants.mjs'

/**
 * Local mirror of passport.mjs's BADGE_MIN_N (20). The authoritative production
 * value flows in via modelGuard's `minFresh` argument (passport passes
 * BADGE_MIN_N explicitly); this default only guards a bare call. Kept as a
 * literal to avoid a passport <-> model-version import cycle.
 */
const DEFAULT_MIN_FRESH = 20

/** The real fs seam, overridable via opts.fs for tests. */
const REAL_FS = {
  readFileSync: fsReadFileSync,
  appendFileSync: fsAppendFileSync,
  mkdirSync: fsMkdirSync,
}

function resolveModelDir(opts = {}) {
  return opts.modelDir ?? MODEL_DIR
}

function resolveNow(now) {
  if (typeof now === 'function') return now()
  if (typeof now === 'string' && now) return now
  return new Date().toISOString()
}

/**
 * resolveModelId({stdinJson, env}) -> {model, source} | null.
 *
 * Probe order (behavior test 2): stdin-JSON `model.id` > `model.display_name` >
 * a plain `model` string (all source 'stdin-json') > env SMA_MODEL (source
 * 'env'). Nothing anywhere -> null (recordModelSighting then NO-OPs).
 *
 * @param {{stdinJson?:object, env?:object}} [args]
 * @returns {{model:string, source:string}|null}
 */
export function resolveModelId({ stdinJson, env } = {}) {
  const j = stdinJson && typeof stdinJson === 'object' ? stdinJson : {}
  const m = j.model
  if (m && typeof m === 'object') {
    if (typeof m.id === 'string' && m.id.trim()) return { model: m.id.trim(), source: 'stdin-json' }
    if (typeof m.display_name === 'string' && m.display_name.trim()) {
      return { model: m.display_name.trim(), source: 'stdin-json' }
    }
  }
  if (typeof m === 'string' && m.trim()) return { model: m.trim(), source: 'stdin-json' }
  const envModel = env && typeof env.SMA_MODEL === 'string' ? env.SMA_MODEL.trim() : ''
  if (envModel) return { model: envModel, source: 'env' }
  return null
}

/**
 * readModelTimeline({modelDir}) -> {sightings, corrupt}. Tolerant JSONL reader
 * (calibration.mjs posture): missing file/dir -> honest empty; a corrupt line
 * is skipped-and-counted, never fatal.
 *
 * @param {{modelDir?:string, fs?:object}} [opts]
 * @returns {{sightings: Array<{model:string, source:string, at:string}>, corrupt:number}}
 */
export function readModelTimeline(opts = {}) {
  const fs = opts.fs ?? REAL_FS
  const file = join(resolveModelDir(opts), 'sightings.jsonl')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { sightings: [], corrupt: 0 }
  }
  const sightings = []
  let corrupt = 0
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      sightings.push(JSON.parse(trimmed))
    } catch {
      corrupt += 1 // fail-open — skip-and-count (C9)
    }
  }
  return { sightings, corrupt }
}

/**
 * timelineSchemaOk(timeline) -> boolean — the `model --schema-check` contract
 * (BL-172, 2026-07-10): a structural receipt over the model-version guard's
 * data feed must pin the timeline's SHAPE, never its COUNT — sightings ACCRUE
 * with every session, so hashing `model --count sightings` output re-fails on
 * every reverify by construction (the 49.3-02 R1 lesson). Valid: an object
 * with a sightings array (empty = honest-empty, still valid) whose every
 * entry carries a non-empty string model plus string source/at, and a finite
 * non-negative corrupt count.
 *
 * @param {*} timeline  a readModelTimeline() result
 * @returns {boolean}
 */
export function timelineSchemaOk(timeline) {
  const t = timeline
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false
  if (!Array.isArray(t.sightings)) return false
  if (!Number.isFinite(t.corrupt) || t.corrupt < 0) return false
  for (const s of t.sightings) {
    if (!s || typeof s !== 'object') return false
    if (typeof s.model !== 'string' || !s.model.trim()) return false
    if (typeof s.source !== 'string' || typeof s.at !== 'string') return false
  }
  return true
}

/**
 * currentModel({modelDir}) -> the last sighting's model, or null on an
 * empty/missing timeline (honest empty, never a fake id).
 *
 * @param {{modelDir?:string, fs?:object}} [opts]
 * @returns {string|null}
 */
export function currentModel(opts = {}) {
  const { sightings } = readModelTimeline(opts)
  if (!sightings.length) return null
  const last = sightings[sightings.length - 1]
  return last && last.model != null ? last.model : null
}

/**
 * recordModelSighting({model, source, modelDir, now}) — append ONE
 * {model, source, at} line to sightings.jsonl, DEDUPED against the last line's
 * model (a repeat of the current model appends nothing). A null/empty model is
 * a NO-OP (no file created). Fully fail-open: any fs error is caught and
 * returned as {ok:false, error}, NEVER thrown — the session-start caller's
 * behavior is provably unchangeable by a telemetry bug (behavior test 7).
 *
 * @param {{model?:string, source?:string, modelDir?:string, now?:*, fs?:object}} [args]
 * @returns {{ok:boolean, appended?:boolean, skipped?:boolean, reason?:string, error?:string}}
 */
export function recordModelSighting(args = {}) {
  const { model, source = 'unknown', now } = args
  if (!model || !String(model).trim()) return { ok: true, skipped: true, reason: 'no-model' }
  const fs = args.fs ?? REAL_FS
  try {
    const dir = resolveModelDir(args)
    const { sightings } = readModelTimeline({ modelDir: dir, fs })
    const last = sightings[sightings.length - 1]
    if (last && last.model === String(model)) return { ok: true, skipped: true, reason: 'dedup' }
    fs.mkdirSync(dir, { recursive: true })
    const record = { model: String(model), source: String(source), at: resolveNow(now) }
    fs.appendFileSync(join(dir, 'sightings.jsonl'), JSON.stringify(record) + '\n')
    return { ok: true, appended: true }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/** ISO string compare guard: only 'hit'/'miss' verdicts are evidence about the CLAIM. */
function isHitOrMiss(r) {
  return r && (r.verdict === 'hit' || r.verdict === 'miss')
}

/**
 * latestVerdictPerPrediction(records) -> records with the hit/miss verdicts
 * DEDUPED by prediction id — the LATEST (by scoredAt/at ISO compare; a tie
 * falls to ledger append order) hit-or-miss verdict per id wins.
 *
 * Re-scoring a prediction APPENDS a new ledger record (append-only by
 * construction); counting records therefore inflates n — the 2026-07-10
 * dogfood lesson: 55 hit/miss records over 45 unique predictions. A
 * prediction's standing verdict is its latest one; everything earlier is
 * superseded evidence, never a second data point.
 *
 * Non-hit/miss records (skipped-unsafe / error / divergence / dispositions)
 * pass through untouched — they are not evidence about the CLAIM and must
 * never shadow a hit/miss. Records without an id are never collapsed.
 *
 * Exported so passport.buildSnapshot counts its calibration totals over the
 * SAME deduped set — one boundary; the guard and the passport cannot disagree.
 *
 * @param {object[]} records
 * @returns {object[]}
 */
export function latestVerdictPerPrediction(records) {
  const list = Array.isArray(records) ? records : []
  const latest = new Map()
  for (const r of list) {
    if (!isHitOrMiss(r) || r.id == null || r.id === '') continue
    const prev = latest.get(r.id)
    if (!prev || String(r.scoredAt ?? r.at ?? '') >= String(prev.scoredAt ?? prev.at ?? '')) {
      latest.set(r.id, r)
    }
  }
  return list.filter((r) => !isHitOrMiss(r) || r.id == null || r.id === '' || latest.get(r.id) === r)
}

/**
 * modelGuard({records, timeline, minFresh}) -> {status, model, freshN,
 * requiredN, lastChangeAt}. Pure function (behavior tests 4-5).
 *
 * - No sightings -> {status:'no-model-data', freshN:0}.
 * - freshN = count of UNIQUE predictions whose LATEST hit/miss verdict is
 *   FRESH under the current model. Records are deduped by prediction id FIRST
 *   (latestVerdictPerPrediction — a re-score appends a duplicate record and
 *   must never inflate n; latest verdict wins), then:
 *     * a STAMPED record (r.model set) is fresh iff r.model === current model;
 *     * an UNSTAMPED legacy record is fresh iff there has been no model change
 *       OR its scoredAt is strictly after the last change sighting's `at`
 *       (ISO string compare) — the whole V2 history stays a valid legacy prefix.
 *     * verdicts other than hit/miss NEVER count.
 * - A model change with freshN < minFresh -> 'stale-priors'; otherwise 'ok'.
 *
 * `records` MUST be prediction-domain calibration records only (caller filters
 * out sma.receipts).
 *
 * @param {{records?:object[], timeline?:{sightings:object[]}, minFresh?:number}} [args]
 */
export function modelGuard({ records = [], timeline, minFresh = DEFAULT_MIN_FRESH } = {}) {
  const sightings = (timeline && Array.isArray(timeline.sightings) ? timeline.sightings : []).filter(
    (s) => s && s.model != null,
  )
  if (!sightings.length) {
    return { status: 'no-model-data', model: null, freshN: 0, requiredN: minFresh, lastChangeAt: null }
  }
  const current = sightings[sightings.length - 1].model

  // The `at` of the LAST transition into a new model. Dedup guarantees adjacent
  // sightings differ, so any sighting after index 0 is a change point.
  let lastChangeAt = null
  for (let i = 1; i < sightings.length; i++) {
    if (sightings[i].model !== sightings[i - 1].model) lastChangeAt = sightings[i].at ?? null
  }
  const hasChange = lastChangeAt != null

  // Accumulate FRESH hit/miss counts under the current model. freshRate is the
  // hit-rate the badge headlines — computed over the SAME set as freshN so the
  // guard is the single source of truth for the fresh window (passport reads it).
  // Dedupe FIRST: one prediction = one data point, its LATEST verdict standing.
  let freshN = 0
  let freshHits = 0
  for (const r of latestVerdictPerPrediction(records)) {
    if (!isHitOrMiss(r)) continue
    const fresh =
      r.model != null ? r.model === current : !hasChange || String(r.scoredAt ?? '') > String(lastChangeAt)
    if (!fresh) continue
    freshN += 1
    if (r.verdict === 'hit') freshHits += 1
  }

  const status = hasChange && freshN < minFresh ? 'stale-priors' : 'ok'
  return {
    status,
    model: current,
    freshN,
    freshHits,
    freshRate: freshN ? freshHits / freshN : null,
    requiredN: minFresh,
    lastChangeAt,
  }
}

/**
 * stampRecords(records, {model}) — pure additive model stamp (behavior test 6).
 * Returns copies each carrying `model` without mutating any other field; a null
 * model returns the records untouched (no `model` key added), so tolerant
 * readers (calibration.mjs parseFile) keep the whole V2 history valid as an
 * unstamped legacy prefix.
 *
 * @param {object[]} records
 * @param {{model?:string|null}} [args]
 */
export function stampRecords(records, { model } = {}) {
  if (!Array.isArray(records)) return records
  if (model == null) return records
  return records.map((r) => ({ ...r, model }))
}
