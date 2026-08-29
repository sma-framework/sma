/**
 * Tests for `countTerminalOutcomes` — daemon/src/queue/attempt-ledger.mjs.
 *
 * WHY THIS EXISTS. The board's «сделано» and «сорвалось» used to be read off the queue
 * library, which counts neither: pg-boss answers `queuedCount`, `activeCount`, `totalCount`
 * and `deferredCount`, and the backend asked it for `completed` and `failed` — two names that
 * are not in the reply, resolving to `undefined ?? 0`. A wrong zero is the one wrong number
 * that looks exactly like a right one, so the counters read «сегодня ничего не сделали» for a
 * day of finished work and nobody had reason to doubt them.
 *
 * The journal of attempts is the source that DOES know how work ended, and it is not archived
 * on a retention window the way a job row is. This file pins the three rules of reading it:
 * ONE TASK ONE VOTE cast by its last try, the SIBLING FILES of a task are not tasks, and an
 * unreadable ledger is `null` — «нет данных» — never zero.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { countTerminalOutcomes, recordAttempt } from '../src/queue/attempt-ledger.mjs'

const tmpDirs: string[] = []
function mkLedgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-ledger-count-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

describe('countTerminalOutcomes — how the work ended, counted where it is recorded', () => {
  it('counts one task per ending, over every task the ledger holds', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-1', attempt: 1, outcome: 'completed', receiptRef: 'reverify:a' })
    recordAttempt(dir, { taskId: 'BL-2', attempt: 1, outcome: 'failed', failureReason: 'agent_error' })
    recordAttempt(dir, { taskId: 'BL-3', attempt: 1, outcome: 'failed', failureReason: 'missing_access' })
    expect(countTerminalOutcomes(dir)).toEqual({ completed: 1, failed: 2 })
  })

  it('an empty but readable ledger is a genuine zero — the daemon makes this dir at boot', () => {
    expect(countTerminalOutcomes(mkLedgerDir())).toEqual({ completed: 0, failed: 0 })
  })

  it('a ledger that cannot be read is «нет данных», not «ничего не сделано»', () => {
    // The two are indistinguishable on a screen and mean opposite things, so they may not
    // share a value. `null` is what makes a reader say the first sentence.
    expect(countTerminalOutcomes(join(mkLedgerDir(), 'no-such-dir'))).toBeNull()
    expect(countTerminalOutcomes('')).toBeNull()
    expect(countTerminalOutcomes(undefined as any)).toBeNull()
  })

  it('THE LAST TRY IS THE VERDICT: a task that broke and then produced counts once, as done', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-9', attempt: 1, outcome: 'failed', failureReason: 'provider_error' })
    recordAttempt(dir, { taskId: 'BL-9', attempt: 2, outcome: 'completed', receiptRef: 'reverify:b' })
    // Not «one failed and one completed»: one task, and it is done. Counting the rows instead
    // of the tasks would make «сделано» and «сорвалось» sum past the work that exists.
    expect(countTerminalOutcomes(dir)).toEqual({ completed: 1, failed: 0 })
  })

  it('a try that is still running is not an ending — the task counts in neither column', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-10', attempt: 1, outcome: 'failed', failureReason: 'runtime_offline' })
    // the queue handed it out again and the tick recorded the start of the new try
    recordAttempt(dir, { taskId: 'BL-10', attempt: 2, workerId: 'w1', startedAt: '2026-08-29T10:00:00.000Z' })
    expect(countTerminalOutcomes(dir)).toEqual({ completed: 0, failed: 0 })
  })

  it('two writers on ONE try are one vote: the rows are folded before they are counted', () => {
    const dir = mkLedgerDir()
    // the state machine's transition row and the tick's outcome row, same attempt
    recordAttempt(dir, { taskId: 'BL-11', attempt: 1, workerId: 'w1', startedAt: '2026-08-29T10:00:00.000Z' })
    recordAttempt(dir, { taskId: 'BL-11', attempt: 1, outcome: 'completed', receiptRef: 'reverify:c' })
    expect(countTerminalOutcomes(dir)).toEqual({ completed: 1, failed: 0 })
  })

  it('the SIBLING files of a task are not tasks — a task is never counted twice', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-12', attempt: 1, outcome: 'completed', receiptRef: 'reverify:d' })
    // `<taskId>.journal.jsonl` is the decision journal of the SAME task; `.log.ndjson` is one
    // attempt's transcript. Both live in this dir on purpose, and neither is a task.
    writeFileSync(
      join(dir, 'BL-12.journal.jsonl'),
      `${JSON.stringify({ taskId: 'BL-12', attempt: 1, layer: 'approach', outcome: 'completed' })}\n`,
      'utf8',
    )
    writeFileSync(join(dir, 'BL-12__1.log.ndjson'), `${JSON.stringify({ at: 1, text: 'hi' })}\n`, 'utf8')
    expect(countTerminalOutcomes(dir)).toEqual({ completed: 1, failed: 0 })
  })

  it('a corrupt line costs its row, never the count — the reader stays fail-open', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-13', attempt: 1, outcome: 'completed', receiptRef: 'reverify:e' })
    writeFileSync(join(dir, 'BL-14.jsonl'), '{not json at all\n', 'utf8')
    expect(countTerminalOutcomes(dir)).toEqual({ completed: 1, failed: 0 })
  })
})
