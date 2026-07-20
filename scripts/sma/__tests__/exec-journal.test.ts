/**
 * Tests for scripts/sma/lib/exec-journal.mjs (Phase 9.1 Plan 20, Task 1 — P5, B14).
 *
 * The per-plan execution progress journal + the resume-point derivation:
 *   - Test 1: append writes the RESEARCH Pattern-5 line shape to
 *     .sma/exec/<phase>-<plan>.jsonl (temp DI dir); read round-trips.
 *   - Test 2: nextUndone({ planTasks: 3, journal }) with task_complete for 1 and 2
 *     returns 3; with all three complete returns null.
 *   - Test 3: a corrupt line is skipped tolerantly; append after corruption works.
 *   - Test 4: simulated mid-plan death — journal shows task 2 of 3 complete;
 *     nextUndone + the last commitSha give the exact resume point.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { append, read, nextUndone } from '../lib/exec-journal.mjs'

let execDir: string
const PLAN = { phase: '9.1', plan: '20' }

beforeEach(() => {
  execDir = mkdtempSync(join(tmpdir(), 'sma-exec-'))
})

afterEach(() => {
  rmSync(execDir, { recursive: true, force: true })
})

describe('append + read — Pattern-5 line shape round-trips', () => {
  it('writes {ts, wave, task, event, file, testRun, commitSha, status} and reads it back', () => {
    append(
      {
        wave: 2,
        task: 3,
        event: 'task_complete',
        file: 'src/crm/x.ts',
        testRun: 'vitest run src/crm/x.test.ts',
        commitSha: 'a1b2c3d',
        status: 'green',
      },
      { ...PLAN, execDir },
    )

    // One file per <phase>-<plan>.
    const raw = readFileSync(join(execDir, '9.1-20.jsonl'), 'utf8').trim()
    expect(raw.split('\n')).toHaveLength(1)

    const { events, count, corrupt } = read({ ...PLAN, execDir })
    expect(count).toBe(1)
    expect(corrupt).toBe(0)
    const e = events[0]
    expect(e.wave).toBe(2)
    expect(e.task).toBe(3)
    expect(e.event).toBe('task_complete')
    expect(e.file).toBe('src/crm/x.ts')
    expect(e.testRun).toBe('vitest run src/crm/x.test.ts')
    expect(e.commitSha).toBe('a1b2c3d')
    expect(e.status).toBe('green')
    expect(typeof e.ts).toBe('string')
  })

  it('carries an extra payload key (blocked-event reason) through verbatim', () => {
    append({ task: 1, event: 'blocked', reason: 'awaiting founder key' }, { ...PLAN, execDir })
    const { events } = read({ ...PLAN, execDir })
    expect(events[0].event).toBe('blocked')
    expect(events[0].reason).toBe('awaiting founder key')
  })
})

describe('nextUndone — resume pick', () => {
  it('returns 3 when tasks 1 and 2 are complete of 3', () => {
    append({ task: 1, event: 'task_complete', commitSha: 'aaa1111' }, { ...PLAN, execDir })
    append({ task: 2, event: 'task_complete', commitSha: 'bbb2222' }, { ...PLAN, execDir })
    const journal = read({ ...PLAN, execDir })
    expect(nextUndone({ planTasks: 3, journal })).toBe(3)
  })

  it('returns null when all tasks are complete', () => {
    for (const t of [1, 2, 3]) {
      append({ task: t, event: 'task_complete', commitSha: `sha${t}` }, { ...PLAN, execDir })
    }
    const journal = read({ ...PLAN, execDir })
    expect(nextUndone({ planTasks: 3, journal })).toBeNull()
  })

  it('accepts a bare events array as well as a {events} report', () => {
    append({ task: 1, event: 'task_complete' }, { ...PLAN, execDir })
    const { events } = read({ ...PLAN, execDir })
    expect(nextUndone({ planTasks: 2, journal: events })).toBe(2)
  })
})

describe('fail-open — corrupt line tolerated', () => {
  it('skips a corrupt line on read and still appends afterwards', () => {
    const file = join(execDir, '9.1-20.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ ts: '2026-07-04T09:00:00Z', task: 1, event: 'task_complete', commitSha: 'ok11111' }),
        '{ this is not json',
      ].join('\n') + '\n',
    )

    // A corrupt line is counted, not thrown.
    let r = read({ ...PLAN, execDir })
    expect(r.count).toBe(1)
    expect(r.corrupt).toBe(1)

    // Append after corruption still works.
    append({ task: 2, event: 'task_complete', commitSha: 'ok22222' }, { ...PLAN, execDir })
    r = read({ ...PLAN, execDir })
    expect(r.count).toBe(2)
    expect(r.corrupt).toBe(1)
    expect(nextUndone({ planTasks: 3, journal: r })).toBe(3)
  })
})

describe('simulated mid-plan death — the resume point', () => {
  it('journal at task 2 of 3 yields the exact resume point (nextUndone + last commitSha)', () => {
    // The 49-14 failure mode: agent completes tasks 1 and 2, dies mid-task-3.
    append(
      { wave: 1, task: 1, event: 'task_complete', commitSha: 'c0ffee1', status: 'green' },
      { ...PLAN, execDir },
    )
    append(
      { wave: 1, task: 2, event: 'task_complete', commitSha: 'deadbe2', status: 'green' },
      { ...PLAN, execDir },
    )
    // No task_complete for task 3 — the terminal died mid-work.

    const journal = read({ ...PLAN, execDir })

    // Step 3 of the resume ritual: pick the next undone task.
    const resumeTask = nextUndone({ planTasks: 3, journal })
    expect(resumeTask).toBe(3)

    // The last recorded commit is the safe HEAD to resume from (ritual step 2:
    // cross-check the journal against `git log`).
    const completed = journal.events.filter((e) => e.event === 'task_complete')
    const lastCommit = completed[completed.length - 1].commitSha
    expect(lastCommit).toBe('deadbe2')

    // Resume point = {resume at task 3, HEAD should be at deadbe2}.
    expect({ resumeTask, lastCommit }).toEqual({ resumeTask: 3, lastCommit: 'deadbe2' })
  })
})
