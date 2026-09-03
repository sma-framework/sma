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
 * THE RATE-LIMIT FRAME — three facts, and only three. The CLI emits `rate_limit_event` on the
 * work stream carrying the vendor's own view of the subscription window: WHICH window, WHETHER
 * it is still allowing work, and WHEN it resets. Verified on a live stream on 12.08.2026:
 *
 *     "rate_limit_info": {"status":"allowed","resetsAt":1786539600,
 *                         "rateLimitType":"five_hour","isUsingOverage":false}
 *
 * The top level of that object carries no fraction of the window spent on an ordinary frame —
 * it appears there only on the warning frames, beside the window they warn about, which is far
 * too rarely to keep a screen current — and the window model once filled the hole with an estimate from
 * this daemon's own token accounting, which read near zero on a subscription mostly spent by a
 * person's own terminal sessions. That estimate is gone.
 *
 * THE FRACTION DOES ARRIVE, one field down, for BOTH windows at once: `unifiedWindows`. It is
 * read here (see windowReadings), and reading it is what keeps the weekly window from being a
 * day out of date — the vendor NAMES that window about once a day, and until this was read the
 * screen only ever learned about the week on those rare frames.
 *
 * THE COMPACTION FRAME — the only place on this stream where the CONTEXT WINDOW speaks. The CLI
 * announces every compaction with a `system` frame of its own:
 *
 *     {"type":"system","subtype":"compact_boundary",
 *      "compact_metadata":{"trigger":"auto","pre_tokens":152000}}
 *
 * Read here for the same reason the spend beside it is read: it is the vendor's own statement
 * about a resource this daemon hands out and cannot otherwise measure. Until it was read, an
 * attempt whose window filled up arrived at the exit gate with no note and no receipt, shaped
 * exactly like bad work — and a person was sent to fix a worker that had simply run out of room.
 *
 * `trigger` is the load-bearing field and it is passed through verbatim rather than judged here:
 * `auto` is the window filling up by itself, `manual` is a worker compacting on purpose, and the
 * two are different facts. Which of them means «the context ran out» is a decision for the reader
 * (loop.mjs), not for the parser — this file states what the frame said. An absent metadata object
 * parses to nulls: a compaction whose trigger nobody stated is not silently called automatic.
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

/**
 * EVERY WINDOW ONE RATE-LIMIT FRAME SPEAKS ABOUT — not only the one it happened to name.
 *
 * `rateLimitType` names the window CLOSEST TO BITING, and nothing else. Beside it the same frame
 * carries `unifiedWindows` — the vendor's own reading of BOTH windows at that instant, each with
 * the fraction spent and its reset:
 *
 *     "rate_limit_info": {"status":"allowed","rateLimitType":"five_hour","resetsAt":1788015000,
 *       "unifiedWindows":{"five_hour":{"utilization":0.18,"resetsAt":1788015000},
 *                         "seven_day":{"utilization":0.03,"resetsAt":1788602400}}}
 *
 * That block went unread, and the cost of not reading it was a screen a day out of date. The
 * weekly window was only ever refreshed on the rare frame that NAMED it — a warning the vendor
 * sends once a day and often less — so on 02.09.2026 the board said the week was 67 % spent from
 * a reading taken nineteen hours earlier, while the very frames arriving that minute carried 7 %
 * in a field nobody opened. One frame is one reading of the whole subscription, and it is read
 * as one here.
 *
 * THE HEALTH WORD RIDES ONLY WHERE THE VENDOR SAID IT. The unified block carries fractions and
 * resets, never a status; only the NAMED window has the vendor's word about whether work is
 * still going through. So the named window's status is folded onto its own entry and onto no
 * other — a second window silently labelled «allowed» would be this daemon's word wearing the
 * vendor's coat, and a refusal is the one thing that must always be his.
 *
 * A reading with no reset time is dropped: the store cannot age what it cannot date.
 *
 * THE FRACTION IS PASSED THROUGH IN THE UNITS THE WIRE USED, and it is the window model
 * (policy/windows.mjs, `utilizationFraction`) that decides what scale those units are in. This
 * file states what the frame said and never re-interprets it, so the one decision about scale
 * lives in one place and is journalled on the day it has to act.
 *
 * AND THE SCALE IS NOW SETTLED BY EVIDENCE, not by the documentation it was read out of. Three
 * frames lifted verbatim off this machine's own stream logs (29.08–30.08.2026) stand as
 * `__tests__/fixtures/claude-stream-rate-limit-unified.ndjson`, and across every rate-limit
 * frame those logs hold, the unified fractions run 0…1 inclusive and never once above it — a
 * refused five-hour window reads exactly `1`. So `0.18` is 18 % and not 18, the guard
 * downstream is a guard and not a translation, and the day it fires is the day the wire
 * changed shape under us.
 */
function windowReadings(obj, info, named) {
  const unified =
    info.unifiedWindows ?? info.unified_windows ?? obj.unifiedWindows ?? obj.unified_windows
  const readings = []
  if (unified && typeof unified === 'object') {
    for (const [limitType, one] of Object.entries(unified)) {
      if (!one || typeof one !== 'object') continue
      const resetsAt = epochMs(one.resetsAt ?? one.resets_at)
      if (resetsAt == null) continue
      const isNamed = named.limitType != null && limitType === named.limitType
      readings.push({
        limitType,
        utilization: numOrNull(one.utilization),
        resetsAt,
        status: isNamed ? named.status : strOrNull(one.status),
        usingOverage: isNamed ? named.usingOverage : one.isUsingOverage === true,
      })
    }
  }
  // The named window still stands on its own where the unified block did not mention it — a
  // frame that carries no unified block at all (every frame before this field existed) must go
  // on being read exactly as it always was.
  if (named.limitType && named.resetsAt != null && !readings.some((r) => r.limitType === named.limitType)) {
    readings.push({ ...named })
  }
  return readings
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
  return eventFromFrame(p.obj)
}

/**
 * parseClaudeFrame(line) → `{ event, frame }` — the SAME typed event as above, plus the
 * parsed frame it was read off.
 *
 * WHY IT EXISTS. Two things now want this line: the tick, which needs the typed event, and
 * the live log, which needs the frame itself to say WHICH TOOL was used in words a person
 * reads. Parsing it twice would be one JSON.parse per line per consumer on a stream that
 * carries every keystroke of a working agent; parsing it once and handing both out is the
 * whole point. `frame` is null exactly when the line was not JSON — the caller then has
 * nothing to summarise and shows the raw line, which is what it has always shown.
 *
 * @param {string} line
 * @returns {{event: object, frame: object|null}}
 */
export function parseClaudeFrame(line) {
  const p = safeParse(line)
  if (!p.ok) return { event: { type: 'unparsed', raw: p.raw }, frame: null }
  return { event: eventFromFrame(p.obj), frame: p.obj }
}

/** The typed event of an ALREADY PARSED frame — the shared body of the two functions above. */
function eventFromFrame(obj) {
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
      // HOW THE RUN ENDED, IN THE CLI'S OWN WORD. These two fields are what a run the WORKER
      // did not end looks like: the vendor refused (an overload, a server error) and the CLI
      // stopped. Until they were read, the only observable was `is_error`, identical for «the
      // provider fell over mid-word» and «the work itself ended badly» — and a screen fed the
      // first one blamed the worker for the vendor's outage. Null on every ordinary result,
      // which is the honest reading: an untroubled run states nothing about a terminal cause.
      terminalReason: strOrNull(obj.terminal_reason ?? obj.terminalReason),
      apiErrorStatus: numOrNull(obj.api_error_status ?? obj.apiErrorStatus),
      // AND HOW THE CLI ITSELF NAMED THE OUTCOME, in one word. The schema of this frame is a
      // CLOSED enumeration — success, or one of four words of failure — and one of those four
      // names a run that walked into the turn ceiling. The same field was already read off the
      // opening frame and never off this one, so a run stopped by a ceiling WE set arrived
      // indistinguishable from a worker's own crash: same «no receipt», same «worker error»,
      // and a person sent to fix work that had nothing wrong with it.
      //
      // Read for a SUCCESS too, on purpose: this is the name of an outcome, not an error flag.
      // A frame that said no such word parses to null — inventing one for the library would be
      // the opposite of reading it.
      subtype: strOrNull(obj.subtype),
      // THE NUMBER THAT MAKES THE READING SURVIVE A RENAME. The word above is the vendor's and
      // can change with his next binary; how many turns were taken is arithmetic, and the
      // ceiling it is compared against is one we handed the process ourselves.
      numTurns: numOrNull(obj.num_turns ?? obj.numTurns),
    }
  }

  if (type === 'system') {
    const subtype = strOrNull(obj.subtype)
    const ev = { type, ...who, subtype, sessionId: strOrNull(obj.session_id ?? obj.sessionId) }
    // WHAT THE WINDOW SAID ABOUT ITSELF — see THE COMPACTION FRAME above. The key exists only on
    // the frame that announces a compaction: an ordinary `system` line states nothing about the
    // context, and giving it an empty reading would make «no compaction» and «a compaction the
    // frame did not describe» the same answer.
    if (subtype === 'compact_boundary') {
      const meta =
        obj.compact_metadata && typeof obj.compact_metadata === 'object'
          ? obj.compact_metadata
          : obj.compactMetadata && typeof obj.compactMetadata === 'object'
            ? obj.compactMetadata
            : {}
      ev.compaction = {
        trigger: strOrNull(meta.trigger),
        preTokens: numOrNull(meta.pre_tokens ?? meta.preTokens),
      }
    }
    return ev
  }

  if (type === 'assistant') {
    const m = obj.message && typeof obj.message === 'object' ? obj.message : {}
    return { type, ...who, model: strOrNull(m.model), usage: m.usage ?? null }
  }

  // THE ONE FRAME THAT KNOWS THE TRUTH ABOUT THE SUBSCRIPTION. Everything else on this stream
  // describes the work; this one describes the ACCOUNT — whether the vendor is still letting
  // it through and when the window resets. It is the vendor's own word, not a count of what
  // this daemon happens to have spawned, so it is the only reading that also covers the
  // sessions a person ran in their own terminal.
  //
  // `status` is the load-bearing field: the healthy values begin with `allowed`, and anything
  // else is a refusal. `rateLimitType` names WHICH window — the CLI sends whichever one is
  // closest to biting, so a stream may carry one, both, or neither, and «neither» is not an
  // error: it means nothing is close. `utilization` would be a FRACTION (0.73) and is kept as
  // one; today it is absent from every real frame and parses to null, which is the honest
  // answer and the reason nothing downstream may require it.
  if (type === 'rate_limit_event') {
    const info = obj.rate_limit_info && typeof obj.rate_limit_info === 'object' ? obj.rate_limit_info : {}
    const named = {
      limitType: strOrNull(info.rateLimitType ?? info.rate_limit_type),
      utilization: numOrNull(info.utilization),
      resetsAt: epochMs(info.resetsAt ?? info.resets_at),
      status: strOrNull(info.status),
      usingOverage: info.isUsingOverage === true,
    }
    return { type: 'rate_limit', ...who, ...named, windows: windowReadings(obj, info, named) }
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
