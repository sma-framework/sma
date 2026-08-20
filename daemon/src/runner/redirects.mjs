/**
 * redirects.mjs — the durable note a founder pins to a RUNNING task: «нет, не так».
 *
 * ═══════════════════ WHY A FILE, AND WHY APPEND-ONLY ═════════════════════════════
 * A redirect is the founder steering live work (recon 11.08 — the Hermes trio
 * interrupt/queue/steer). The steering wheel must survive a daemon restart: a correction
 * typed a second before a crash has to reach the worker after the crash, or the founder
 * learns to distrust the wheel. So the note is written to disk BEFORE anything is killed,
 * as one NDJSON line per event, append-only — the same posture every ledger in this
 * product takes. Consumption is an appended `done` record, never an edit: the file tells
 * the whole story in order, and two processes appending cannot corrupt each other's lines.
 *
 * ═══════════════════ WHAT A REDIRECT IS NOT ══════════════════════════════════════
 * Not a queue row (it belongs to a task that already has one), not a journal layer (the
 * journal's three-layer vocabulary is closed and deserves its own deliberate extension —
 * recorded as follow-up work, not smuggled in at night), and never TRUTH about the task's
 * state — the queue owns that. Losing this file loses only unconsumed corrections, and
 * the founder can see that and repeat themselves; nothing else in the system leans on it.
 *
 * Node built-ins only; fs and clock injectable; zero deps.
 */

import { appendFileSync as fsAppend, readFileSync as fsRead, mkdirSync as fsMkdir, existsSync as fsExists } from 'node:fs'
import { join, dirname } from 'node:path'

/** The two fates a typed-while-busy text can have. A third value is refused at the door. */
export const REDIRECT_MODES = Object.freeze(['interrupt', 'queue'])

/** A correction is a paragraph, not a document. The cap is the door's, stated once. */
export const REDIRECT_TEXT_CAP = 4000

/** How many continuation hops one attempt may take before the loop must end (endable-loop law). */
export const REDIRECT_HOP_CAP = 5

/** Task ids are already ID_RE-checked at the door; this keeps the path join honest anyway. */
function safeTask(taskId) {
  return String(taskId ?? '').replace(/[^\w.-]+/g, '_')
}

function fileOf(dataDir, taskId) {
  return join(dataDir, 'redirects', `${safeTask(taskId)}.ndjson`)
}

/**
 * redirectFileOf({dataDir, taskId}) → the ONE path this task's corrections live at.
 *
 * Exported because a second reader now exists and it does not run inside the daemon: the
 * parking gate runs in the WORKER's child process, where neither `dataDir` nor the task id
 * is in hand — only a path handed to it in the environment. Minting that path is this
 * module's business, so the daemon asks for it here instead of the far side guessing at a
 * directory layout it does not own.
 */
export function redirectFileOf({ dataDir, taskId } = {}) {
  if (!dataDir || !taskId) return null
  return fileOf(dataDir, taskId)
}

/**
 * appendRedirect({dataDir, taskId, text, mode, clock, fsImpl}) → {ok, id?, error?}.
 * Validates mode and text (non-empty, capped) and appends ONE `ask` line. The id is
 * minted from the injected clock plus the file's own growing length — unique per task
 * without reaching for randomness.
 */
export function appendRedirect({ dataDir, taskId, text, mode, clock = Date.now, fsImpl } = {}) {
  const append = fsImpl?.appendFileSync ?? fsAppend
  const mkdir = fsImpl?.mkdirSync ?? fsMkdir
  if (!dataDir || !taskId) return { ok: false, error: 'no store' }
  if (!REDIRECT_MODES.includes(mode)) return { ok: false, error: 'bad mode' }
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, error: 'empty text' }
  if (body.length > REDIRECT_TEXT_CAP) return { ok: false, error: 'text too long' }

  const existing = readAllFrom(fileOf(dataDir, taskId), fsImpl)
  const id = `rd-${clock()}-${existing.length + 1}`
  mkdir(join(dataDir, 'redirects'), { recursive: true })
  append(fileOf(dataDir, taskId), `${JSON.stringify({ kind: 'ask', id, ts: new Date(clock()).toISOString(), mode, text: body })}\n`, 'utf8')
  return { ok: true, id }
}

/** Every parseable line of ONE redirect file, in order. Missing file → []. */
function readAllFrom(file, fsImpl) {
  const read = fsImpl?.readFileSync ?? fsRead
  const exists = fsImpl?.existsSync ?? fsExists
  if (!file || !exists(file)) return []
  let raw = ''
  try {
    raw = String(read(file, 'utf8'))
  } catch {
    return [] // an unreadable store loses only unconsumed corrections — never wedges a tick
  }
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* a torn line is skipped, the rest of the story still reads */
    }
  }
  return out
}

/**
 * readPendingRedirectsFile({file, fsImpl}) → asks of ONE file not yet marked done.
 * The PATH-shaped half of the contract: the gate in the worker's child process holds a
 * path and nothing else, and «which lines are still pending» is a rule that must be
 * answered by this module in both processes or it is two rules.
 */
export function readPendingRedirectsFile({ file, fsImpl } = {}) {
  const rows = readAllFrom(file, fsImpl)
  const done = new Set(rows.filter((r) => r && r.kind === 'done').map((r) => r.id))
  return rows.filter((r) => r && r.kind === 'ask' && !done.has(r.id))
}

/**
 * markConsumedFile({file, ids, clock, fsImpl}) — append one `done` line per id to ONE
 * file. Consumption is an APPENDED record, never an edit — the same posture the daemon
 * side takes, and the reason two processes appending cannot corrupt each other.
 */
export function markConsumedFile({ file, ids = [], clock = Date.now, fsImpl } = {}) {
  const append = fsImpl?.appendFileSync ?? fsAppend
  const mkdir = fsImpl?.mkdirSync ?? fsMkdir
  if (!file || !ids.length) return
  mkdir(dirname(file), { recursive: true })
  const ts = new Date(clock()).toISOString()
  for (const id of ids) {
    append(file, `${JSON.stringify({ kind: 'done', id, ts })}\n`, 'utf8')
  }
}

/**
 * readPendingRedirects({dataDir, taskId, fsImpl}) → asks not yet marked done, in order.
 */
export function readPendingRedirects({ dataDir, taskId, fsImpl } = {}) {
  return readPendingRedirectsFile({ file: fileOf(dataDir, taskId), fsImpl })
}

/** markConsumed({dataDir, taskId, ids, clock, fsImpl}) — append one `done` line per id. */
export function markConsumed({ dataDir, taskId, ids = [], clock = Date.now, fsImpl } = {}) {
  if (!dataDir || !taskId || !ids.length) return
  markConsumedFile({ file: fileOf(dataDir, taskId), ids, clock, fsImpl })
}
