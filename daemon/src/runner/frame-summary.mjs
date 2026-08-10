/**
 * frame-summary.mjs — turning one stream frame into the sentence a PERSON reads.
 *
 * WHAT THIS IS FOR. The live attempt log has always shown the worker's stdout exactly as it
 * arrived: a stream-json frame per line, rendered as text. That is correct and it is also
 * unreadable — a person watching a run sees `{"type":"assistant","message":{"content":[{...`
 * and cannot answer the two questions they actually have: WHICH TOOLS is it using, and WHAT
 * did it hand to the subagent it just started. Both answers are inside those frames. Nothing
 * extracted them.
 *
 * WHY IT RUNS AT WRITE TIME AND NOT IN THE SCREEN. Two reasons, and the second is the one that
 * decides it:
 *   - the raw line is CAPPED at the storage boundary, and a frame longer than the cap arrives
 *     at any reader as a truncated string that is no longer valid JSON. A session-init frame is
 *     eleven thousand characters; a file read or a delegation prompt is easily more. Summarise
 *     after the cap and exactly the biggest, most interesting frames are the ones that cannot
 *     be read. Summarise before it and the tool name survives whatever the cap does to the rest.
 *   - one parse per line, in one place, rather than one per line per open screen.
 *
 * EVERYTHING HERE IS UNTRUSTED TEXT AND STAYS TEXT. A tool name, a command, a file path and a
 * delegation prompt are all written by a program that was left alone with a project. This
 * module extracts them into short, single-line, length-capped strings and marks what kind of
 * thing each one is; it never interprets them, never builds markup, and the screen renders
 * them as text children exactly as it renders a raw line today. Newlines and control characters
 * are folded to spaces HERE, so a summary cannot forge a second row in the log it appears in.
 *
 * NEVER THROWS, on any input, for the same reason the parsers next door never throw: a
 * worker's garbage output must not kill the tick that is watching it. Anything unrecognisable
 * summarises to nothing at all, and «nothing» means the reader falls back to the raw line,
 * which is what it has always shown.
 *
 * Zero imports. Pure.
 */

/** A summary is a glance, not a transcript — the raw line is still stored beside it. */
const DETAIL_CAP = 200

/** How much of a tool result is worth keeping: enough to see «ok» or the first error words. */
const RESULT_CAP = 160

/**
 * WHICH FIELD OF A TOOL CALL IS THE ONE WORTH SHOWING.
 *
 * Named per tool rather than guessed, because the interesting field differs and guessing gets
 * it wrong in the most common cases: a Bash call's `description` is a label somebody wrote,
 * while its `command` is what will actually run on the machine. Ordered — the first present
 * field wins. A tool absent from this table falls back to the generic rule below, so a new
 * tool degrades to «shown by name with its first short string» rather than disappearing.
 */
const TOOL_DETAIL_FIELDS = Object.freeze({
  Bash: ['command'],
  PowerShell: ['command'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Skill: ['skill'],
  Task: ['description', 'prompt'],
  Agent: ['description', 'prompt'],
  TodoWrite: [],
})

/** The tools whose whole purpose is to hand work to ANOTHER agent. */
const HANDOFF_TOOLS = Object.freeze(['Task', 'Agent'])

/**
 * Control characters, as an escaped class rather than as literal bytes in the source.
 *
 * Written out because the literal form is invisible in an editor and one careless keystroke
 * turns it into an ordinary printable range — `[space-hyphen]`, say, which silently eats
 * punctuation out of every command this log displays.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

/** One line, no control characters, capped — safe to sit in a row of a log. */
function oneLine(value, cap) {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string') return ''
  // Newlines fold to a single space: a summary that could contain one could pretend to be two
  // rows of the log it is printed in.
  const flat = text.replace(CONTROL_CHARS, ' ').replace(/\s{2,}/g, ' ').trim()
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat
}

/** The first field of a tool's input worth printing, by the table above then by shape. */
function detailOfToolInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  const named = Object.prototype.hasOwnProperty.call(TOOL_DETAIL_FIELDS, name) ? TOOL_DETAIL_FIELDS[name] : null
  if (named) {
    for (const field of named) {
      const value = input[field]
      if (typeof value === 'string' && value.trim()) return oneLine(value, DETAIL_CAP)
    }
    return ''
  }
  // An unknown tool: the first short string in its input is nearly always the subject —
  // a path, a pattern, a query. A long one is a payload and says nothing at a glance.
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() && value.length <= 400) return oneLine(value, DETAIL_CAP)
  }
  return ''
}

/** The content blocks of a frame, whatever shape the frame wrapped them in. */
function blocksOf(obj) {
  const message = obj && typeof obj.message === 'object' && obj.message !== null ? obj.message : null
  const content = message ? message.content : null
  return Array.isArray(content) ? content : []
}

/**
 * summarizeFrame(obj) → an array of {kind, …} parts, possibly empty.
 *
 * One frame can carry several blocks — a thought and the tool call it led to — so the answer
 * is a list and not a single part. An empty list means «this frame has nothing a person needs»,
 * and the caller keeps showing the raw line.
 *
 * Kinds, and what each one is FOR:
 *   tool        — the worker used a tool. `tool` names it, `detail` is what it was pointed at.
 *   handoff     — the worker started ANOTHER agent. `detail` is the brief it handed over, which
 *                 is the single most asked-for line in this whole log.
 *   tool_result — that tool answered. `ok` says whether it worked.
 *   text        — the worker spoke.
 *   thinking    — the worker reasoned. Kept separate so a screen can dim or fold it.
 *   result      — the session finished; `detail` carries cost and turns.
 *   limit       — the subscription window reading (see stream.mjs).
 *
 * @param {object} obj a PARSED stream frame (not a string)
 * @returns {Array<{kind:string, tool?:string, detail?:string, ok?:boolean, subagent?:string}>}
 */
export function summarizeFrame(obj) {
  try {
    if (!obj || typeof obj !== 'object') return []
    const type = typeof obj.type === 'string' ? obj.type : ''

    if (type === 'assistant') {
      const parts = []
      for (const block of blocksOf(obj)) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          parts.push({ kind: 'text', detail: oneLine(block.text, DETAIL_CAP) })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          parts.push({ kind: 'thinking', detail: oneLine(block.thinking, DETAIL_CAP) })
        } else if (block.type === 'tool_use') {
          const tool = oneLine(block.name, 60) || 'инструмент'
          const detail = detailOfToolInput(block.name, block.input)
          if (HANDOFF_TOOLS.includes(block.name)) {
            const subagent = oneLine(block.input && block.input.subagent_type, 60)
            parts.push({ kind: 'handoff', tool, ...(detail ? { detail } : {}), ...(subagent ? { subagent } : {}) })
          } else {
            parts.push({ kind: 'tool', tool, ...(detail ? { detail } : {}) })
          }
        }
      }
      return parts
    }

    if (type === 'user') {
      const parts = []
      for (const block of blocksOf(obj)) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue
        // `is_error` is the block's own verdict; the frame's `tool_use_result.success` is the
        // CLI's. Either saying «no» is a no — a result nobody called successful is not one.
        const explicitError = block.is_error === true
        const outerSuccess =
          obj.tool_use_result && typeof obj.tool_use_result === 'object' ? obj.tool_use_result.success !== false : true
        const detail = oneLine(block.content, RESULT_CAP)
        parts.push({ kind: 'tool_result', ok: !explicitError && outerSuccess, ...(detail ? { detail } : {}) })
      }
      return parts
    }

    if (type === 'result') {
      const cost = Number(obj.total_cost_usd)
      const turns = Number(obj.num_turns)
      const bits = []
      if (Number.isFinite(cost)) bits.push(`$${cost.toFixed(4)}`)
      if (Number.isFinite(turns)) bits.push(`ходов: ${turns}`)
      return [{ kind: 'result', ok: obj.is_error !== true, ...(bits.length ? { detail: bits.join(' · ') } : {}) }]
    }

    if (type === 'rate_limit_event') {
      const info = obj.rate_limit_info && typeof obj.rate_limit_info === 'object' ? obj.rate_limit_info : {}
      const pct = Number(info.utilization)
      if (!Number.isFinite(pct)) return []
      const which =
        info.rateLimitType === 'seven_day' ? 'неделя' : info.rateLimitType === 'five_hour' ? '5 часов' : ''
      return [
        { kind: 'limit', detail: oneLine(`окно подписки${which ? ` (${which})` : ''}: ${Math.round(pct * 100)}%`, DETAIL_CAP) },
      ]
    }

    // Everything else — session init, hook chatter, token counters — is machinery, not work.
    // Summarising it would fill the log with rows nobody reads and bury the ones they do.
    return []
  } catch {
    return []
  }
}
