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

/** How many names of one kind (connections, tools) a single line will carry before «+N». */
const LIST_CAP = 6

/**
 * A RUN OF CHARACTERS THIS LONG WITH NO BREAK IN IT IS NOT LANGUAGE.
 *
 * A stream carries encoded payloads — a reasoning signature, the bytes of a screenshot, a
 * token — and they are the exact thing that made this log unreadable for the person it is
 * for: a wall of base64 where a sentence should be. Length is the honest test, not a guess at
 * what the field means: no word, path, command or error message runs sixty-four characters
 * without a space, a slash, a dot or a comma, while every encoded blob does. What is dropped
 * is announced by its size rather than silently cut, so a reader is never left wondering
 * whether the interesting part was the part that vanished.
 */
const BINARY_RUN = /[A-Za-z0-9+/_-]{64,}={0,2}/g

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
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Skill: ['args', 'skill'],
  ToolSearch: ['query'],
  Task: ['description', 'prompt'],
  Agent: ['description', 'prompt'],
  TodoWrite: [],
})

/** The tools whose whole purpose is to hand work to ANOTHER agent. */
const HANDOFF_TOOLS = Object.freeze(['Task', 'Agent'])

/** How a connection's tools are named on the wire: `mcp__<server>__<operation>`. */
const MCP_PREFIX = 'mcp__'

/**
 * Which CONNECTION a tool call went to, and what it asked of it.
 *
 * A person watching their own machine work has a right to know that it just spoke to their
 * mail, their tracker or their browser — and the vendor's tool name is the only place that
 * fact exists. It is split here rather than displayed whole because `mcp__claude_ai_Gmail__
 * search_messages` reads as one long identifier and «Gmail · search_messages» reads as a
 * sentence. Split on the SECOND separator only: an operation name may itself contain one.
 */
function mcpTarget(name) {
  const rest = name.slice(MCP_PREFIX.length)
  const cut = rest.indexOf('__')
  return cut === -1 ? { server: rest, op: '' } : { server: rest.slice(0, cut), op: rest.slice(cut + 2) }
}

/**
 * Control characters, as an escaped class rather than as literal bytes in the source.
 *
 * Written out because the literal form is invisible in an editor and one careless keystroke
 * turns it into an ordinary printable range — `[space-hyphen]`, say, which silently eats
 * punctuation out of every command this log displays.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

/** One line, no control characters, no encoded blobs, capped — safe to sit in a row of a log. */
function oneLine(value, cap) {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string') return ''
  // Newlines fold to a single space: a summary that could contain one could pretend to be two
  // rows of the log it is printed in.
  const flat = text
    .replace(CONTROL_CHARS, ' ')
    .replace(BINARY_RUN, (blob) => `[двоичные данные: ${blob.length} симв.]`)
    .replace(/\s{2,}/g, ' ')
    .trim()
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat
}

/**
 * WHAT A TOOL ANSWERED, IN WORDS — even when the answer was not words.
 *
 * A result block carries either a string or a list of blocks, and one of those block kinds is
 * an IMAGE: a screenshot arrives as several hundred kilobytes of base64 in a field called
 * `data`. Handing that list to `JSON.stringify` — which is what «print the result» used to
 * mean — puts the encoded picture into the line a person reads. So the list is walked: text
 * is text, and anything else is named by its kind. «[изображение]» is the whole truth about
 * an image on a log row, and it costs sixteen characters instead of half a megabyte.
 */
function textOfResultContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content)
  const bits = []
  let size = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    let bit = ''
    if (block.type === 'text' && typeof block.text === 'string') bit = block.text
    else if (block.type === 'image') bit = '[изображение]'
    else if (typeof block.type === 'string') bit = `[${block.type}]`
    if (!bit) continue
    bits.push(bit)
    size += bit.length
    // Enough to fill the cap twice over is enough: the rest cannot reach the screen anyway,
    // and a result with ten thousand blocks must not be walked ten thousand times.
    if (size > RESULT_CAP * 2) break
  }
  return bits.join(' ')
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

/**
 * WHICH CONNECTIONS THIS SESSION WAS GIVEN, from whichever field the CLI happens to carry.
 *
 * Two shapes, and both are read rather than one being trusted: `mcp_servers` is the explicit
 * list (entries are names or `{name}` objects), and when it is absent the tool list still
 * holds the answer, because every connection's tools are named `mcp__<server>__<op>`. The
 * result is deduplicated and capped — a machine with thirty connections must not push the
 * rest of the line off the screen — and `more` says out loud how many were not printed.
 */
function connectionNames(obj) {
  const seen = new Set()
  const raw = Array.isArray(obj.mcp_servers) ? obj.mcp_servers : []
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.name : ''
    const clean = oneLine(name, 60)
    if (clean) seen.add(clean)
  }
  if (seen.size === 0) {
    for (const tool of Array.isArray(obj.tools) ? obj.tools : []) {
      if (typeof tool !== 'string' || !tool.startsWith(MCP_PREFIX)) continue
      const clean = oneLine(mcpTarget(tool).server, 60)
      if (clean) seen.add(clean)
    }
  }
  const all = [...seen]
  return { list: all.slice(0, LIST_CAP), more: Math.max(0, all.length - LIST_CAP) }
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
 *   mcp         — the worker used a CONNECTION. `tool` is the server; `detail` the operation.
 *   skill       — the worker turned on a skill. `tool` names it.
 *   handoff     — the worker started ANOTHER agent. `detail` is the brief it handed over, which
 *                 is the single most asked-for line in this whole log.
 *   tool_result — that tool answered. `ok` says whether it worked.
 *   text        — the worker spoke.
 *   thinking    — the worker reasoned. Kept separate so a screen can dim or fold it.
 *   session     — what the session was armed with: tool count, connections, model.
 *   apikey      — the vendor named a billed credential for this session. Absent = it did not.
 *   denied      — a tool call was REFUSED by permission. `ok` is false.
 *   progress    — a long tool is still running, with how long it has been at it.
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
          const name = typeof block.name === 'string' ? block.name : ''
          const tool = oneLine(name, 60) || 'инструмент'
          const detail = detailOfToolInput(name, block.input)
          if (HANDOFF_TOOLS.includes(name)) {
            const subagent = oneLine(block.input && block.input.subagent_type, 60)
            parts.push({ kind: 'handoff', tool, ...(detail ? { detail } : {}), ...(subagent ? { subagent } : {}) })
          } else if (name.startsWith(MCP_PREFIX)) {
            // A CONNECTION IS NOT AN ORDINARY TOOL and is not shown as one: `tool` carries the
            // server, so «which of my connections did it touch» is answerable by reading one
            // column, and the operation joins the detail where the subject already is.
            const { server, op } = mcpTarget(name)
            const both = [oneLine(op, 60), detail].filter(Boolean).join(' · ')
            parts.push({ kind: 'mcp', tool: oneLine(server, 60) || name, ...(both ? { detail: both } : {}) })
          } else if (name === 'Skill') {
            const skill = oneLine(block.input && block.input.skill, 60)
            parts.push({ kind: 'skill', tool: skill || 'навык', ...(detail && detail !== skill ? { detail } : {}) })
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
        const detail = oneLine(textOfResultContent(block.content), RESULT_CAP)
        parts.push({ kind: 'tool_result', ok: !explicitError && outerSuccess, ...(detail ? { detail } : {}) })
      }
      return parts
    }

    if (type === 'system') {
      // WHAT THE SESSION WAS GIVEN, said once, at the top. The person who asked for the work
      // wants to know what their machine was armed with before it started — how many tools,
      // and above all WHICH CONNECTIONS, because a connection reaches outside this computer.
      if (obj.subtype === 'init') {
        const tools = Array.isArray(obj.tools) ? obj.tools : []
        const servers = connectionNames(obj)
        const bits = []
        if (tools.length) bits.push(`инструментов: ${tools.length}`)
        if (servers.list.length) {
          const shown = servers.list.join(', ')
          bits.push(`подключения: ${shown}${servers.more ? ` (+${servers.more})` : ''}`)
        }
        const model = oneLine(obj.model, 60)
        if (model) bits.push(`модель: ${model}`)
        const parts = bits.length ? [{ kind: 'session', detail: oneLine(bits.join(' · '), DETAIL_CAP) }] : []
        // WHICH CREDENTIAL THE SESSION RAN ON — its own part, because «did this cost money»
        // is a question with its own answer and not a clause inside another sentence. The
        // vendor's `apiKeySource` is the only place in the stream that distinguishes a run on
        // the plan from a run on a billed key. It is reported only when the field is actually
        // there and names something other than «none»: an absent field states NOTHING, and
        // reading «подписка» out of its absence would be exactly the confident guess to avoid.
        const key = oneLine(obj.apiKeySource, 60)
        if (key && key !== 'none') parts.push({ kind: 'apikey', detail: key })
        return parts
      }

      // A REFUSAL IS THE MOST IMPORTANT LINE IN ANY TRANSCRIPT THAT CONTAINS ONE: the work
      // did not do what it tried to do, and every later line reads differently once you know.
      if (obj.subtype === 'permission_denied') {
        const tool = oneLine(obj.tool_name, 60)
        const detail = oneLine(obj.message, DETAIL_CAP)
        return [{ kind: 'denied', ok: false, ...(tool ? { tool } : {}), ...(detail ? { detail } : {}) }]
      }

      // The rest of the `system` traffic — the token counters, and the two lifecycle frames
      // that announce a background task starting and finishing — says nothing a reader does
      // not already have: both lifecycle frames carry the id of a tool call whose own row is
      // already in this log, so summarising them would print every background command three
      // times. They stay in the raw view, where a person debugging the machine looks.
      return []
    }

    if (type === 'tool_progress') {
      // “IS IT STUCK?” is the question a person asks at minute four of a silent command, and
      // this frame is the only thing in the stream that answers it.
      const tool = oneLine(obj.tool_name, 60)
      const sec = Number(obj.elapsed_time_seconds)
      if (!Number.isFinite(sec)) return []
      return [{ kind: 'progress', ...(tool ? { tool } : {}), detail: `идёт ${Math.round(sec)} с` }]
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
      const which =
        info.rateLimitType === 'seven_day' ? 'неделя' : info.rateLimitType === 'five_hour' ? '5 часов' : ''
      const status = oneLine(info.status, 40)
      // A WINDOW READING WITHOUT A PERCENTAGE IS STILL A WINDOW READING, and dropping it was
      // costing the one channel fact this stream carries: the vendor sends this frame only
      // about a SUBSCRIPTION window, so its mere presence answers «шло ли это по подписке» —
      // which is half of what a person means when they ask whether the work cost money. The
      // percentage is printed when it is there and nothing is printed in its place when it is
      // not; a frame with neither a type nor a status says nothing at all and is dropped.
      if (!Number.isFinite(pct) && !which && !status) return []
      const said = Number.isFinite(pct) ? `${Math.round(pct * 100)}%` : status
      return [{ kind: 'limit', detail: oneLine(`окно подписки${which ? ` (${which})` : ''}${said ? `: ${said}` : ''}`, DETAIL_CAP) }]
    }

    // Everything else — hook chatter and the counters beside it — is machinery, not work.
    // Summarising it would fill the log with rows nobody reads and bury the ones they do.
    return []
  } catch {
    return []
  }
}
