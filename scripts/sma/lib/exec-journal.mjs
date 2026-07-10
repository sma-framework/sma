/**
 * exec-journal.mjs — per-plan execution progress journal (P5, B14).
 *
 * The EXACT append-only-JSONL shape as journal.mjs, applied to plan EXECUTION
 * instead of coordination EVENTS (RESEARCH Pattern 5, Anthropic long-running-agent
 * harness). One file per <phase>-<plan>: `.sma/exec/<phase>-<plan>.jsonl`. Every
 * completed sub-step (task/wave/commit) appends one line — so a terminal death
 * mid-plan leaves the execution state on disk as data, and the resume ritual
 * (execute-plan.md) reconstructs the exact resume point in <=5 minutes.
 *
 * Fail-open (C9): a corrupt line is skipped-and-counted, never a throw; a missing
 * journal yields a zero-event report. Appends are best-effort at the call site
 * (T-9.1-44): a missing line degrades resume quality, never blocks work.
 *
 * Node built-ins only; the exec dir is dependency-injectable via the option.
 */

import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { EXEC_DIR } from './constants.mjs'

/** Event kinds the journal records (RESEARCH Pattern 5; blocked reused by 9.1-21). */
export const EXEC_EVENTS = ['task_start', 'task_complete', 'wave_complete', 'blocked', 'plan_complete']

function resolveExecDir(opts = {}) {
  return opts.execDir ?? EXEC_DIR
}

/** The one JSONL file for a given <phase>-<plan>. */
function fileFor(opts) {
  return join(resolveExecDir(opts), `${opts.phase}-${opts.plan}.jsonl`)
}

/** Read + parse one plan's .jsonl, skipping corrupt lines (fail-open C9). */
function parseFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { events: [], corrupt: 0 }
  }
  const events = []
  let corrupt = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      corrupt += 1 // fail-open — skip-and-count, never throw (C9)
    }
  }
  return { events, corrupt }
}

/**
 * append(entry, opts) — append one JSON line to `.sma/exec/<phase>-<plan>.jsonl`.
 * The line shape is RESEARCH Pattern 5: {ts, wave, task, event, file, testRun,
 * commitSha, status}. Any extra keys on `entry` (e.g. `reason` on a blocked event)
 * are carried through verbatim.
 * @param {{wave?:number, task?:number, event?:string, file?:string, testRun?:string, commitSha?:string, status?:string}} entry
 * @param {{phase:string|number, plan:string|number, execDir?:string, now?:string}} opts
 * @returns {object} the written record
 */
export function append(entry, opts = {}) {
  const dir = resolveExecDir(opts)
  mkdirSync(dir, { recursive: true })
  const file = fileFor(opts)

  const record = {
    ts: opts.now ?? new Date().toISOString(),
    wave: entry.wave ?? null,
    task: entry.task ?? null,
    event: entry.event ?? 'task_complete', // task_start|task_complete|wave_complete|blocked|plan_complete
    file: entry.file ?? null,
    testRun: entry.testRun ?? null,
    commitSha: entry.commitSha ?? null,
    status: entry.status ?? null,
    // Carry any extra payload (e.g. a blocked event's `reason` — 9.1-21 park protocol).
    ...Object.fromEntries(
      Object.entries(entry).filter(
        ([k]) => !['wave', 'task', 'event', 'file', 'testRun', 'commitSha', 'status'].includes(k),
      ),
    ),
  }
  appendFileSync(file, JSON.stringify(record) + '\n')
  return record
}

/**
 * read(opts) -> {events, count, corrupt}. Reads one plan's JSONL line-wise,
 * skipping corrupt lines. Missing file -> zero-event report.
 * @param {{phase:string|number, plan:string|number, execDir?:string}} opts
 */
export function read(opts = {}) {
  const { events, corrupt } = parseFile(fileFor(opts))
  return { events, count: events.length, corrupt }
}

/**
 * nextUndone({ planTasks, journal }) -> the lowest 1-based task number in
 * [1..planTasks] that has no `task_complete` entry, or null when every task is
 * complete. This is the resume ritual's step-3 pick (execute-plan.md).
 * @param {{planTasks:number, journal:(object[]|{events:object[]})}} args
 * @returns {number|null}
 */
export function nextUndone({ planTasks, journal }) {
  const events = Array.isArray(journal) ? journal : (journal?.events ?? [])
  const done = new Set(
    events.filter((e) => e && e.event === 'task_complete' && e.task != null).map((e) => Number(e.task)),
  )
  for (let t = 1; t <= planTasks; t++) {
    if (!done.has(t)) return t
  }
  return null
}
