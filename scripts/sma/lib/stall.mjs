/**
 * stall.mjs — rule-based stall detection over a rolling PostToolUse window
 * (9.1-21, B16 sibling; OpenHands StuckDetector doctrine).
 *
 * DOCTRINE (RESEARCH Anti-pattern A1, plan prohibition): detection is
 * DETERMINISTIC and rule-based — NEVER an LLM judgment. Four rules over the
 * last N events of one session:
 *
 *   1. same-action-repeat — SAME_ACTION_REPEAT consecutive identical tool
 *      calls (same tool name + same tool_input hash).
 *   2. same-error-repeat  — SAME_ERROR_REPEAT consecutive events whose error
 *      output matches after normalization (digits stripped, whitespace
 *      collapsed — so "foo.ts:123" and "foo.ts:456" are the SAME error).
 *   3. ping-pong          — PINGPONG_CYCLES full A-B-A-B cycles of Edit/Write
 *      alternation between exactly two files.
 *   4. monologue          — GUARDED: fires only if the hook payload exposes a
 *      tool-less-turns counter (turns_without_tools / toolless_turns). The
 *      standard PostToolUse payload does NOT carry turn info (A4 spike
 *      finding: session_id, transcript_path, cwd, hook_event_name, tool_name,
 *      tool_input, tool_response — no turn counters), so this rule is inert
 *      in practice until Claude Code ships such a field.
 *
 * State lives in .sma/stall/<session>.json — a bounded rolling array
 * (WINDOW_SIZE events, old events age out by count) written via fs-atomics.
 * Everything is fail-open (C9): errors yield empty results, never throws.
 * The consumer (cli.mjs stall-check) is ADVISORY ONLY — additionalContext
 * nudge, never a block. SMA_STALL_DISABLE is the global kill-switch
 * (T-9.1-46). Node built-ins only.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { atomicWriteJson, readJsonSafe } from './fs-atomics.mjs'
import { STALL_DIR } from './constants.mjs'

// ── exported thresholds (no magic numbers in detect()) ───────────────────────

/** Consecutive identical tool calls that count as a loop. */
export const SAME_ACTION_REPEAT = 4
/** Consecutive normalized-identical errors that count as a loop. */
export const SAME_ERROR_REPEAT = 3
/** Full A-B cycles of two-file edit alternation that count as ping-pong. */
export const PINGPONG_CYCLES = 2
/** Tool-less assistant turns that count as a monologue (guarded rule 4). */
export const MONOLOGUE_TURNS = 6
/** Rolling window bound — old events age out by count, size stays constant. */
export const WINDOW_SIZE = 20

/** Tools whose events carry a file target (ping-pong operates on these). */
const EDIT_TOOLS = new Set(['Edit', 'Write'])

// ── helpers ──────────────────────────────────────────────────────────────────

/** True when the SMA_STALL_DISABLE kill-switch is set (T-9.1-46). */
function isDisabled(env) {
  const v = String((env || {}).SMA_STALL_DISABLE ?? '').trim().toLowerCase()
  return Boolean(v) && v !== '0' && v !== 'false'
}

/** Short deterministic hash of a tool_input payload. */
function hashInput(input) {
  try {
    return createHash('sha1').update(JSON.stringify(input ?? {})).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}

/**
 * Normalize an error string into a comparable signature: lowercase, digits
 * stripped (line numbers / counts / pids), whitespace collapsed, bounded.
 */
function normalizeErr(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * Extract an error signature from a PostToolUse tool_response. Deterministic
 * field checks only: explicit `error`, non-empty `stderr`, or `is_error` with
 * a string payload. Anything else (green stdout, plain objects) is NOT an
 * error — the healthy-fixture negative depends on this staying conservative.
 */
function errSigFrom(resp) {
  if (!resp || typeof resp !== 'object') return ''
  let raw = ''
  if (typeof resp.error === 'string' && resp.error.trim()) raw = resp.error
  else if (typeof resp.stderr === 'string' && resp.stderr.trim()) raw = resp.stderr
  else if (resp.is_error === true) {
    raw =
      typeof resp.output === 'string'
        ? resp.output
        : typeof resp.content === 'string'
          ? resp.content
          : 'error'
  }
  return normalizeErr(raw)
}

/** Sanitize a session token into a safe filename stem. */
function sessionFile(token) {
  const stem = String(token || 'unknown').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80)
  return `${stem || 'unknown'}.json`
}

/**
 * Compact a raw PostToolUse hook payload into a window event:
 * {tool, inputHash, errSig, target, toolless, ts}.
 */
function eventFrom(evt, now) {
  const e = evt && typeof evt === 'object' ? evt : {}
  const tool = typeof e.tool_name === 'string' ? e.tool_name : ''
  const input = e.tool_input && typeof e.tool_input === 'object' ? e.tool_input : {}
  const target =
    typeof input.file_path === 'string' ? input.file_path.replace(/\\/g, '/').toLowerCase() : ''
  // GUARDED monologue field (rule 4): absent on the standard payload -> null.
  const rawTurns = e.turns_without_tools ?? e.toolless_turns
  const toolless = Number.isFinite(Number(rawTurns)) && rawTurns != null ? Number(rawTurns) : null
  return {
    tool,
    inputHash: hashInput(input),
    errSig: errSigFrom(e.tool_response),
    target,
    toolless,
    ts: new Date(now ?? Date.now()).toISOString(),
  }
}

// ── core API ─────────────────────────────────────────────────────────────────

/**
 * recordEvent(evt, {stallDir, sessionToken, env, now}) — append a compact
 * event to the per-session rolling window at <stallDir>/<session>.json
 * (bounded at WINDOW_SIZE; fs-atomics write) and return the updated window.
 *
 * Fail-open (C9): any error returns []. Under SMA_STALL_DISABLE nothing is
 * recorded and [] is returned.
 *
 * @param {object} evt  PostToolUse hook payload (tool_name/tool_input/tool_response)
 * @param {{stallDir?:string, sessionToken?:string|null, env?:object, now?:number}} [opts]
 * @returns {Array<object>} the window AFTER the append (possibly empty)
 */
export function recordEvent(evt, opts = {}) {
  try {
    if (isDisabled(opts.env ?? process.env)) return []
    const dir = opts.stallDir ?? STALL_DIR
    const file = join(dir, sessionFile(opts.sessionToken))
    const stored = readJsonSafe(file)
    const prev = stored && Array.isArray(stored.events) ? stored.events : []
    const events = [...prev, eventFrom(evt, opts.now)].slice(-WINDOW_SIZE)
    atomicWriteJson(file, { session: String(opts.sessionToken || 'unknown'), events })
    return events
  } catch {
    return [] // fail-open (C9)
  }
}

/** Last n events of a window, only if the window holds at least n. */
function tail(events, n) {
  return events.length >= n ? events.slice(-n) : null
}

/**
 * detect(events, {env}) — run the four deterministic rules over the window.
 * Returns null (healthy) or {pattern, detail} naming the detected loop.
 * NEVER an LLM call; thresholds are the exported constants only.
 *
 * @param {Array<object>} events  the rolling window (recordEvent's return)
 * @param {{env?:object}} [opts]
 * @returns {{pattern:string, detail:string}|null}
 */
export function detect(events, opts = {}) {
  try {
    if (isDisabled(opts.env ?? process.env)) return null
    if (!Array.isArray(events) || !events.length) return null

    // Rule 1 — same-action-repeat: N identical tool+input signatures in a row.
    const acts = tail(events, SAME_ACTION_REPEAT)
    if (acts) {
      const sig = (e) => `${e.tool}::${e.inputHash}`
      const first = sig(acts[0])
      if (first !== '::' && acts.every((e) => sig(e) === first)) {
        return {
          pattern: 'same-action-repeat',
          detail: `${SAME_ACTION_REPEAT} повтора одного действия подряд (${acts[0].tool})`,
        }
      }
    }

    // Rule 2 — same-error-repeat: N normalized-identical errors in a row.
    const errs = tail(events, SAME_ERROR_REPEAT)
    if (errs && errs.every((e) => e.errSig) && errs.every((e) => e.errSig === errs[0].errSig)) {
      return {
        pattern: 'same-error-repeat',
        detail: `${SAME_ERROR_REPEAT} одинаковые ошибки подряд («${errs[0].errSig.slice(0, 60)}»)`,
      }
    }

    // Rule 3 — ping-pong: PINGPONG_CYCLES full A-B cycles of Edit/Write
    // alternation between exactly two files.
    const span = PINGPONG_CYCLES * 2
    const pp = tail(events, span)
    if (pp && pp.every((e) => EDIT_TOOLS.has(e.tool) && e.target)) {
      const a = pp[0].target
      const b = pp[1].target
      if (a !== b && pp.every((e, i) => e.target === (i % 2 === 0 ? a : b))) {
        return {
          pattern: 'ping-pong',
          detail: `правки чередуются между двумя файлами A-B-A-B (${a} <-> ${b})`,
        }
      }
    }

    // Rule 4 — monologue (GUARDED, A4): only when the payload exposed a
    // tool-less-turns counter; the standard PostToolUse payload does not.
    const last = events[events.length - 1]
    if (last && typeof last.toolless === 'number' && last.toolless >= MONOLOGUE_TURNS) {
      return {
        pattern: 'monologue',
        detail: `${last.toolless} ходов подряд без вызова инструментов`,
      }
    }

    return null
  } catch {
    return null // fail-open (C9)
  }
}

/** Per-pattern break-action suggestions for the advisory nudge. */
const BREAK_ACTIONS = {
  'same-action-repeat':
    'перечитайте текущую задачу плана и смените подход; если действие заблокировано, запаркуйте план (park-and-continue)',
  'same-error-repeat':
    'прогоните целевой smoke-тест и перечитайте текст ошибки целиком, прежде чем править дальше',
  'ping-pong':
    'остановитесь и зафиксируйте, какое из двух конкурирующих изменений верное, прежде чем продолжать',
  monologue: 'вернитесь к конкретному действию (Edit/Bash) или запаркуйте план (park-and-continue)',
}

/**
 * formatNudge(detection) — the ADVISORY additionalContext text: names the
 * detected pattern and suggests a break action. Never a block instruction.
 *
 * @param {{pattern?:string, detail?:string}|null} detection
 * @returns {string}
 */
export function formatNudge(detection) {
  try {
    if (!detection || !detection.pattern) return ''
    const suggestion = BREAK_ACTIONS[detection.pattern] ?? BREAK_ACTIONS['same-action-repeat']
    const detail = detection.detail ? `: ${detection.detail}` : ''
    return `SMA-стоп-сигнал: обнаружен паттерн ${detection.pattern}${detail}. Предлагаемый выход: ${suggestion}.`
  } catch {
    return '' // fail-open (C9)
  }
}
