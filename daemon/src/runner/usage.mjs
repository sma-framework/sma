/**
 * usage.mjs — usage capture into the spend book, incl. the Codex gap (Phase 9.5 Plan
 * 04, Task 3; D-9.5-03, Pitfall 5; Assumption A4).
 *
 * WHAT IT IS: the runner's OWN honest usage ledger. Every worker session — Claude or
 * Codex, subscription or API — books a canonical usage row so subscription work is NEVER
 * counted as $0 (Pitfall 5, «Subscriptions as $0 in budgets» — our differentiator). The
 * window/budget layer (plan 9.5-05) and the roster window bars (plan 9.5-08) read these
 * rows; this module is their data source.
 *
 * THE SEAM (researcher left it open — decided here): the runner books its OWN canonical
 * rows under `<dataDir>/usage/` rather than extending ADAPTER_VERSIONS in
 * scripts/sma/lib/spend-adapter.mjs. Rationale: keep scripts/sma/lib (the zero-dep
 * substrate) UNTOUCHED by daemon concerns; a future spend-adapter entry can ingest these
 * rows if the two sources ever merge. This is a runner-side canonical event, append-only.
 *
 * TWO INDEPENDENT SOURCES, reconciled at the roster:
 *   1. THIS module — the runner books per-session rows from the parsed stream/final events.
 *   2. The EXISTING `sma spend` ledger — because args.mjs sets SMA_SPEND_LOGS_DIR per
 *      worker env, the ledger's adapter also sees each Claude account's session JSONL.
 *   Plan 9.5-08 displays both; they cross-check each other. Codex has no vendor JSONL the
 *   `sma spend` adapter understands (the GAP), so for Codex THIS module is the only source.
 *
 * COST HONESTY (Pitfall 5): a Claude `result` event carries `total_cost_usd` verbatim
 * (source 'stream-result'). A Codex `turn.completed` event carries token counts (source
 * 'codex-final'). When the Codex final event LACKS tokens (A4 unverified), we book a
 * time-based estimate (source 'estimate') — a non-zero row, never a blind $0.
 *
 * SECURITY: a usage row carries ids + token counts + optional cost ONLY — never an OAuth
 * token, never task content, never an env-var name (T-9.5-12).
 *
 * Node built-ins only; fs is dependency-injectable so tests never touch a real ledger.
 * Zero deps; zero network.
 */

import { appendFileSync as fsAppend, readFileSync as fsRead, mkdirSync as fsMkdir } from 'node:fs'
import { join } from 'node:path'

/** Coarse time-based token rate for the estimate fallback (documented heuristic, A4). */
const EST_OUTPUT_TOKENS_PER_SEC = 20

/** Finite non-negative token count (else 0). */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * claudeUsageFromResult(resultEvent, ctx) → a canonical usage row from a parsed Claude
 * `result` event (parseClaudeEvent output). Sums the modelUsage token counts and carries
 * the event's total_cost_usd verbatim. source: 'stream-result'.
 *
 * @param {{totalCostUsd?:number|null, modelUsage?:object|null}} resultEvent
 * @param {{accountName?:string, taskId?:string, model?:string}} [ctx]
 * @returns {object}
 */
export function claudeUsageFromResult(resultEvent = {}, { accountName, taskId, model } = {}) {
  const modelUsage = resultEvent && typeof resultEvent.modelUsage === 'object' ? resultEvent.modelUsage : {}
  const modelKeys = Object.keys(modelUsage || {})
  const modelName = model ?? modelKeys[0] ?? null

  let inputTokens = 0
  let outputTokens = 0
  for (const k of modelKeys) {
    const mu = modelUsage[k] || {}
    inputTokens += num(mu.inputTokens ?? mu.input_tokens)
    outputTokens += num(mu.outputTokens ?? mu.output_tokens)
  }

  const row = {
    accountName: accountName ?? null,
    provider: 'claude',
    taskId: taskId ?? null,
    model: modelName,
    inputTokens,
    outputTokens,
    source: 'stream-result',
  }
  const cost = Number(resultEvent && resultEvent.totalCostUsd)
  if (Number.isFinite(cost)) row.costUsd = cost
  return row
}

/**
 * codexUsageFromFinal(finalEvent, ctx) → a canonical usage row from a parsed Codex
 * `turn.completed` event (parseCodexEvent output). When the event carries token counts →
 * source 'codex-final'. When it does NOT (the A4 gap) → falls back to estimateUsage
 * (source 'estimate') so the row is never a blind $0 (Pitfall 5).
 *
 * @param {{usage?:object}} finalEvent
 * @param {{accountName?:string, taskId?:string, model?:string, startedAt?:number, endedAt?:number}} [ctx]
 * @returns {object}
 */
export function codexUsageFromFinal(finalEvent = {}, ctx = {}) {
  const usage = finalEvent && typeof finalEvent.usage === 'object' ? finalEvent.usage : {}
  const inputTokens = num(usage.input_tokens ?? usage.inputTokens)
  const outputTokens = num(usage.output_tokens ?? usage.outputTokens)

  if (inputTokens === 0 && outputTokens === 0) {
    return estimateUsage(ctx) // A4 gap — book a time-based estimate, never blind $0
  }

  return {
    accountName: ctx.accountName ?? null,
    provider: 'codex',
    taskId: ctx.taskId ?? null,
    model: ctx.model ?? null,
    inputTokens,
    outputTokens,
    source: 'codex-final',
  }
}

/**
 * estimateUsage(ctx) → a time-based usage row (source 'estimate') when no token counts
 * are available. Books a NON-ZERO output-token estimate from the session duration so
 * subscription work is never silently $0 (Pitfall 5). Coarse by design; labeled honestly.
 *
 * @param {{accountName?:string, taskId?:string, model?:string, startedAt?:number, endedAt?:number}} [ctx]
 * @returns {object}
 */
export function estimateUsage({ accountName, taskId, model, startedAt, endedAt } = {}) {
  const durationMs = Math.max(0, (Number(endedAt) || 0) - (Number(startedAt) || 0))
  const estOutputTokens = Math.max(1, Math.round((durationMs / 1000) * EST_OUTPUT_TOKENS_PER_SEC))
  return {
    accountName: accountName ?? null,
    provider: 'codex',
    taskId: taskId ?? null,
    model: model ?? null,
    inputTokens: 0,
    outputTokens: estOutputTokens,
    source: 'estimate',
  }
}

/**
 * bookUsage({dataDir, event, clock, fsImpl}) → the written row. Appends ONE canonical
 * usage row to the append-only `<dataDir>/usage/usage.jsonl`. Missing fields are
 * normalized; `ts` defaults to the injected clock. No secret ever enters the row.
 *
 * @param {{dataDir:string, event:object, clock?:Function, fsImpl?:object}} opts
 * @returns {object} the row written
 */
export function bookUsage({ dataDir, event = {}, clock = Date.now, fsImpl } = {}) {
  const appendFileSync = fsImpl?.appendFileSync ?? fsAppend
  const mkdirSync = fsImpl?.mkdirSync ?? fsMkdir

  const dir = join(dataDir, 'usage')
  mkdirSync(dir, { recursive: true })

  const row = {
    ts: event.ts ?? new Date(clock()).toISOString(),
    accountName: event.accountName ?? null,
    provider: event.provider ?? null,
    taskId: event.taskId ?? null,
    model: event.model ?? null,
    inputTokens: num(event.inputTokens),
    outputTokens: num(event.outputTokens),
    source: event.source ?? 'unknown',
  }
  if (Number.isFinite(Number(event.costUsd))) row.costUsd = Number(event.costUsd)

  appendFileSync(join(dir, 'usage.jsonl'), JSON.stringify(row) + '\n', 'utf8')
  return row
}

/**
 * readUsage({dataDir, accountName, windowMs, clock, fsImpl}) → per-account rolling-window
 * totals. Sums input/output tokens + cost over rows for `accountName` whose `ts` falls
 * inside [now - windowMs, now]. A missing book → all-zero totals (fail-open, never throws).
 * This is the input for plan 9.5-05's window bars.
 *
 * @param {{dataDir:string, accountName?:string, windowMs?:number, clock?:Function, fsImpl?:object}} opts
 * @returns {{accountName:string|undefined, inputTokens:number, outputTokens:number, costUsd:number, rows:number, windowMs:number|undefined}}
 */
export function readUsage({ dataDir, accountName, windowMs, clock = Date.now, fsImpl } = {}) {
  const readFileSync = fsImpl?.readFileSync ?? fsRead
  const empty = { accountName, inputTokens: 0, outputTokens: 0, costUsd: 0, rows: 0, windowMs }

  let text = ''
  try {
    text = readFileSync(join(dataDir, 'usage', 'usage.jsonl'), 'utf8')
  } catch {
    return empty // no book yet → an empty window, never an error
  }

  const now = clock()
  const cutoff = windowMs ? now - windowMs : Number.NEGATIVE_INFINITY
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  let rows = 0

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue // a corrupt row is skipped, never fatal
    }
    if (accountName && r.accountName !== accountName) continue
    if (windowMs) {
      const t = Date.parse(r.ts)
      if (Number.isFinite(t) && t < cutoff) continue
    }
    inputTokens += num(r.inputTokens)
    outputTokens += num(r.outputTokens)
    if (Number.isFinite(Number(r.costUsd))) costUsd += Number(r.costUsd)
    rows += 1
  }

  return { accountName, inputTokens, outputTokens, costUsd, rows, windowMs }
}
