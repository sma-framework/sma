/**
 * stream.mjs — the NDJSON stream parsers for both worker lanes.
 *
 * WHAT IT IS: two pure functions that turn ONE line of a worker's stdout into a small
 * typed event the runner acts on. They are the boundary between hostile child output and
 * the daemon tick.
 *
 * NEVER-THROW CONTRACT (journal.mjs / spend-adapter.mjs fail-open posture): a
 * worker's garbage output must NOT kill the tick. Any non-JSON / non-object / unexpected
 * line returns `{ type: 'unparsed', raw }` — the parsers never throw on any input. An
 * unparsed line is counted by the caller as drift; the tick survives.
 *
 * CLAUDE FIELD NAMES (verified against the research example — the CLI's `result` event):
 *   total_cost_usd, modelUsage, session_id. system init carries session_id; assistant
 *   events carry message.usage. Field names are the CLI's, mapped to our camelCase view.
 *
 * SUBAGENT PROVENANCE — `parent_tool_use_id`. With `--forward-subagent-text` the CLI puts
 * the text and thinking of DELEGATED sessions on the same stream as the main one, and the
 * only thing that tells the two apart is a `parent_tool_use_id` on the frame: present means
 * "this line was spoken by a subagent, under that tool call". Every event therefore carries
 * `subagent` — `true`/`false`, never absent — so a reader is never left guessing whether the
 * flag was omitted or the answer was no. The parent id itself is an OPAQUE string, passed
 * through verbatim: it is not parsed, not interpreted and not trusted, and it is CAPPED at
 * the storage boundary (front/journal.mjs owns every cap in this system) rather than here,
 * so one rule lives in one place.
 *
 * THE RATE-LIMIT FRAME — measured, not assumed. The CLI emits `rate_limit_event` carrying the
 * vendor's own view of the subscription window: which window, what fraction of it is spent,
 * when it resets. This was long believed not to exist (the window model was written around
 * «there is no official quota API» and estimated the bars from the daemon's own token
 * accounting), which made every bar read near zero on a machine whose subscription was mostly
 * spent by a person's own terminal sessions. The frame is real, it arrives on every spawn, and
 * parsing it is what lets the roster stop guessing.
 *
 * ASSUMPTION A4 (Codex, MEDIUM confidence — verified in the pilot): `codex exec --json`
 * emits a thread-start event carrying `thread_id` and a final `turn.completed` event
 * carrying a `usage` object with token counts sufficient for the ledger. If the final
 * event lacks tokens, usage.mjs books a time-based estimate (never $0-blind).
 *
 * Node built-ins only; zero deps; zero network; zero LLM. Pure transforms.
 */

/** Finite number or null. */
function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Non-empty string or null. */
function strOrNull(v) {
  return typeof v === 'string' && v.trim() ? v : null
}

/**
 * An epoch stamp in MILLISECONDS, whichever unit the wire used.
 *
 * The CLI sends `resetsAt` in SECONDS, and the cost of not noticing is silent and total: read
 * as milliseconds, a reset three days out lands in January 1970, so every freshness check
 * declares the reading stale the instant it is written and the whole measurement is discarded
 * without an error anywhere. The two units cannot be confused by accident — a seconds stamp of
 * this era is ~1.7e9 and a milliseconds one is ~1.7e12 — so the boundary below is a decade
 * away from any real value in either unit.
 */
function epochMs(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

/** JSON.parse that yields an unparsed marker instead of throwing. */
function safeParse(line) {
  const raw = String(line ?? '')
  if (!raw.trim()) return { ok: false, raw }
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return { ok: false, raw }
    return { ok: true, obj, raw }
  } catch {
    return { ok: false, raw }
  }
}

/**
 * Who spoke this frame: the MAIN session, or a subagent it delegated to. `parent_tool_use_id`
 * present → a subagent line, and the opaque parent id travels with it so a screen can group
 * a delegated burst under the tool call that started it. Absent → `{subagent:false}` and no
 * id at all: an absent id is not the empty string.
 */
function provenanceOf(obj) {
  const parentId = strOrNull(obj.parent_tool_use_id ?? obj.parentToolUseId)
  return parentId ? { subagent: true, parentId } : { subagent: false }
}

/**
 * parseClaudeEvent(line) → typed event. For system/assistant events returns { type, … };
 * for a `result` event extracts { totalCostUsd, modelUsage, sessionId }. Every parsed event
 * also carries { subagent, parentId? } — see SUBAGENT PROVENANCE above. A malformed line
 * → { type: 'unparsed', raw }. NEVER throws.
 *
 * @param {string} line
 * @returns {object}
 */
export function parseClaudeEvent(line) {
  const p = safeParse(line)
  // An unparsed line has no frame to read provenance OFF — claiming `subagent:false` for it
  // would be an answer invented from nothing. It keeps exactly the shape it always had.
  if (!p.ok) return { type: 'unparsed', raw: p.raw }
  const obj = p.obj
  const type = typeof obj.type === 'string' ? obj.type : 'unknown'
  const who = provenanceOf(obj)

  if (type === 'result') {
    return {
      type,
      ...who,
      totalCostUsd: numOrNull(obj.total_cost_usd),
      modelUsage: obj.modelUsage ?? obj.model_usage ?? null,
      sessionId: strOrNull(obj.session_id ?? obj.sessionId),
      isError: obj.is_error === true,
    }
  }

  if (type === 'system') {
    return { type, ...who, subtype: strOrNull(obj.subtype), sessionId: strOrNull(obj.session_id ?? obj.sessionId) }
  }

  if (type === 'assistant') {
    const m = obj.message && typeof obj.message === 'object' ? obj.message : {}
    return { type, ...who, model: strOrNull(m.model), usage: m.usage ?? null }
  }

  // THE ONE FRAME THAT KNOWS THE TRUTH ABOUT THE SUBSCRIPTION. Everything else on this stream
  // describes the work; this one describes the ACCOUNT — how much of its rolling window is
  // spent, when that window resets, and whether the vendor is still letting it through. It is
  // the vendor's own number, not a count of what this daemon happens to have spawned, so it is
  // the only reading that includes the sessions a person ran in their own terminal.
  //
  // `utilization` is a FRACTION on the wire (0.73) and is kept as one here; turning it into a
  // percentage is the business of whoever draws a bar. `rateLimitType` names WHICH window —
  // the CLI sends whichever one is closest to biting, so a stream may carry one, both, or
  // neither, and «neither» is not an error: it means nothing is close.
  if (type === 'rate_limit_event') {
    const info = obj.rate_limit_info && typeof obj.rate_limit_info === 'object' ? obj.rate_limit_info : {}
    return {
      type: 'rate_limit',
      ...who,
      limitType: strOrNull(info.rateLimitType ?? info.rate_limit_type),
      utilization: numOrNull(info.utilization),
      resetsAt: epochMs(info.resetsAt ?? info.resets_at),
      status: strOrNull(info.status),
      usingOverage: info.isUsingOverage === true,
    }
  }

  return { type, ...who }
}

/**
 * parseCodexEvent(line) → typed event. Extracts `threadId` when the line carries a thread
 * id (thread.started), and `usage` when the line is the final token-count event
 * (turn.completed). A malformed line → { type: 'unparsed', raw }. NEVER throws.
 *
 * @param {string} line
 * @returns {object}
 */
export function parseCodexEvent(line) {
  const p = safeParse(line)
  if (!p.ok) return { type: 'unparsed', raw: p.raw }
  const obj = p.obj
  const type = typeof obj.type === 'string' ? obj.type : 'unknown'
  const out = { type }

  const threadId = obj.thread_id ?? obj.threadId ?? (obj.thread && typeof obj.thread === 'object' ? obj.thread.id : undefined)
  if (threadId) out.threadId = String(threadId)

  // Final usage event. Preserve the raw usage shape for usage.mjs mapping.
  if (obj.usage && typeof obj.usage === 'object') out.usage = obj.usage

  return out
}
