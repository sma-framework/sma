/**
 * Tests for daemon/src/queue/bug-journal.mjs — ЕДИНЫЙ ЖУРНАЛ СРЫВОВ.
 *
 * ЧТО ЗДЕСЬ ЗАКРЕПЛЕНО, и почему именно это:
 *   - ДВА СЛОВА О ПРИЧИНЕ СТОЯТ РЯДОМ И НЕ ПЕРЕБИВАЮТ ДРУГ ДРУГА. Слово очереди (`reason` —
 *     ровно то, что видит человек на карточке) и слово реестра (`cause` — на чём сломалась
 *     последняя сорвавшаяся попытка). На живой очереди они расходятся: задача упирается в
 *     потолок ходов, человек потом снимает её рукой, и экран говорит «остановлено вручную».
 *     Журнал, который выбрал бы одно из двух, был бы четвёртым местом с неполной правдой.
 *   - ОДИН СРЫВ — ОДНА СТРОКА. Проход бежит каждый тик; журнал, растущий на строку в секунду,
 *     не читает никто.
 *   - ПУСТОТА НАЗЫВАЕТСЯ ПУСТОТОЙ. Задача, снятая из очереди без единой попытки, получает
 *     `cause: null` и `attemptsRecorded: 0`, а НЕ «подход номер ноль»: `Number(null)` — ноль,
 *     и ровно так нули однажды и попали в живой журнал.
 *   - ДАТА ПРИХОДИТ ОБЪЕКТОМ. Читатель очереди отдаёт `completedAt` как `Date`; текстовая
 *     проверка роняла его в null, и журнал стоял без единой отметки времени, выглядя целым.
 *   - FAIL-OPEN ВЕЗДЕ: журнал — наблюдение за работой, а не условие её.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUG_JOURNAL_FILE,
  BUG_TEXT_CAP,
  ALLOWED_BUG_KEYS,
  bugJournalPath,
  bugKey,
  normalizeBug,
  appendBug,
  readBugs,
  causeOf,
  bugFromRow,
  summarizeBugs,
  sweepBugJournal,
} from '../src/queue/bug-journal.mjs'

const tmpDirs: string[] = []
function mkLedgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-bugs-'))
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

/** A ledger seam over a plain map of task id -> attempt rows, plus the journal on disk. */
function mkLedger(dir: string, attempts: Record<string, any[]> = {}) {
  return {
    readAttempts: (id: string) => attempts[id] ?? [],
    readBugs: () => readBugs(dir),
    appendBug: (entry: any) => appendBug(dir, entry),
  }
}

const failedRow = (over: any = {}) => ({
  id: 'R-1',
  status: 'failed',
  project: 'sma',
  title: 'ночная ротация лога',
  attempt: 3,
  failure_reason: 'attempts_exhausted',
  completedAt: '2026-08-27T15:27:07.379Z',
  ...over,
})

describe('the bug journal is one append-only file beside the ledger', () => {
  it('writes one line per failure and reads it back', () => {
    const dir = mkLedgerDir()
    const row = appendBug(dir, { taskId: 'R-1', project: 'sma', reason: 'manual', cause: 'no_journal', attempt: 2 })

    expect(row).toBeTruthy()
    expect(bugJournalPath(dir).endsWith(BUG_JOURNAL_FILE)).toBe(true)
    expect(readBugs(dir)).toEqual([row])
    expect(readFileSync(bugJournalPath(dir), 'utf8').endsWith('\n')).toBe(true)
  })

  it('carries the allowlisted keys only, in one order, whatever the caller passes', () => {
    const dir = mkLedgerDir()
    const row: any = appendBug(dir, {
      taskId: 'R-1',
      reason: 'manual',
      // a caller's stray facts may never reach a durable record
      acceptance: 'секрет',
      env: { TOKEN: 'shhh' },
    })
    expect(Object.keys(row)).toEqual([...ALLOWED_BUG_KEYS])
    expect(JSON.stringify(row)).not.toContain('shhh')
  })

  it('refuses a record with no task in it, and writes nothing at all', () => {
    const dir = mkLedgerDir()
    expect(appendBug(dir, { reason: 'manual' })).toBeNull()
    expect(normalizeBug({ taskId: '   ' })).toBeNull()
    expect(readBugs(dir)).toEqual([])
  })

  it('records a failure NOBODY explained — that absence is the answer, not a refusal', () => {
    const dir = mkLedgerDir()
    const row: any = appendBug(dir, { taskId: 'R-9' })
    expect(row.reason).toBeNull()
    expect(row.cause).toBeNull()
    expect(summarizeBugs(readBugs(dir)).silent).toEqual(['R-9'])
  })

  it('reads a missing journal as empty and skips a corrupt line (fail-open)', () => {
    const dir = mkLedgerDir()
    expect(readBugs(dir)).toEqual([])
    expect(readBugs('')).toEqual([])
    appendBug(dir, { taskId: 'R-1', reason: 'manual' })
    writeFileSync(bugJournalPath(dir), `${readFileSync(bugJournalPath(dir), 'utf8')}{ не json\n`, 'utf8')
    expect(readBugs(dir)).toHaveLength(1)
  })

  it('caps a title a person wrote as long as they liked', () => {
    const row: any = normalizeBug({ taskId: 'R-1', title: 'я'.repeat(BUG_TEXT_CAP + 50) })
    expect(row.title).toHaveLength(BUG_TEXT_CAP)
  })
})

describe('what a row says about the cause — two words, never one', () => {
  it('keeps the queue’s word and the ledger’s word apart', () => {
    const row: any = bugFromRow(failedRow({ failure_reason: 'manual' }), [
      { taskId: 'R-1', attempt: 1, outcome: 'failed', failureReason: 'turns_exhausted', workerId: 'max-2' },
    ])
    expect(row.reason).toBe('manual') // what the card shows
    expect(row.cause).toBe('turns_exhausted') // what actually broke
    expect(row.causeAttempt).toBe(1)
  })

  it('takes the LAST failed attempt, and counts attempts rather than ledger rows', () => {
    // Two writers append per attempt — the transition and the tick — so three rows here are
    // two attempts, and a count over rows would tell a person four.
    const led = causeOf([
      { attempt: 1, outcome: 'failed', failureReason: 'tests_red' },
      { attempt: 2, outcome: 'failed', failureReason: 'liveness_killed' },
      { attempt: 2, outcome: 'failed', failureReason: 'liveness_killed', workerId: 'max-2' },
    ])
    expect(led).toEqual({ cause: 'liveness_killed', causeAttempt: 2, attemptsRecorded: 2, workerId: 'max-2' })
  })

  it('a task nobody ever attempted says so — «no attempt», never «attempt zero»', () => {
    const row: any = bugFromRow(failedRow({ failure_reason: 'manual' }), [])
    expect(row.cause).toBeNull()
    expect(row.causeAttempt).toBeNull() // Number(null) is 0, and 0 here would be a measurement
    expect(row.attemptsRecorded).toBe(0)
  })

  it('takes the end mark as the queue hands it over — a Date object, not only a string', () => {
    const row: any = bugFromRow(failedRow({ completedAt: new Date('2026-08-27T15:27:07.379Z') }), [])
    expect(row.endedAt).toBe('2026-08-27T15:27:07.379Z')
    expect(bugFromRow(failedRow({ completedAt: new Date('nonsense') }), [])!.endedAt).toBeNull()
  })

  it('says nothing about work that did not fail', () => {
    expect(bugFromRow(failedRow({ status: 'completed' }), [])).toBeNull()
    expect(bugFromRow(null as any, [])).toBeNull()
  })
})

describe('the sweep fills the journal and keeps filling it — one row per failure', () => {
  it('writes every failed task the queue knows, and nothing about the rest', async () => {
    const dir = mkLedgerDir()
    const ledger = mkLedger(dir, { 'R-1': [{ attempt: 3, outcome: 'failed', failureReason: 'liveness_killed' }] })
    const rows = [failedRow(), failedRow({ id: 'R-2', status: 'completed' }), failedRow({ id: 'R-3', project: 'sma-dev', failure_reason: 'manual' })]

    const summary = await sweepBugJournal({ rows, ledger })

    expect(summary).toEqual({ examined: 2, appended: 2, skipped: 0 })
    const written = readBugs(dir)
    expect(written.map((r: any) => r.taskId)).toEqual(['R-1', 'R-3'])
    expect(written[0]).toMatchObject({ reason: 'attempts_exhausted', cause: 'liveness_killed', project: 'sma' })
    expect(written[1]).toMatchObject({ reason: 'manual', cause: null, project: 'sma-dev' })
  })

  it('is idempotent — the tick may run it every few seconds', async () => {
    const dir = mkLedgerDir()
    const ledger = mkLedger(dir)
    const rows = [failedRow()]

    await sweepBugJournal({ rows, ledger })
    const second = await sweepBugJournal({ rows, ledger })

    expect(second).toEqual({ examined: 1, appended: 0, skipped: 1 })
    expect(readBugs(dir)).toHaveLength(1)
  })

  it('a NEW failure of the same task is a new line — a retry that broke again is a new event', async () => {
    const dir = mkLedgerDir()
    const ledger = mkLedger(dir)

    await sweepBugJournal({ rows: [failedRow({ attempt: 1, failure_reason: 'tests_red' })], ledger })
    await sweepBugJournal({ rows: [failedRow({ attempt: 2, failure_reason: 'tests_red' })], ledger })
    // …and so is the same attempt whose word the queue changed (a human stop over a ceiling)
    await sweepBugJournal({ rows: [failedRow({ attempt: 2, failure_reason: 'manual' })], ledger })

    expect(readBugs(dir).map((r: any) => bugKey(r))).toEqual(['R-1#1|tests_red', 'R-1#2|tests_red', 'R-1#2|manual'])
  })

  it('asks the adapter itself when no rows are handed in', async () => {
    const dir = mkLedgerDir()
    const adapter = { list: async () => [failedRow()] }
    const summary = await sweepBugJournal({ adapter, ledger: mkLedger(dir) })
    expect(summary.appended).toBe(1)
  })

  it('a queue that will not answer costs the journal a pass and nothing else', async () => {
    const dir = mkLedgerDir()
    const adapter = {
      list: async () => {
        throw new Error('база отвернулась')
      },
    }
    await expect(sweepBugJournal({ adapter, ledger: mkLedger(dir) })).resolves.toEqual({
      examined: 0,
      appended: 0,
      skipped: 0,
    })
    expect(readBugs(dir)).toEqual([])
  })

  it('without the ledger seams it does nothing — the DI guard, never a throw', async () => {
    await expect(sweepBugJournal({ rows: [failedRow()] })).resolves.toEqual({ examined: 0, appended: 0, skipped: 0 })
    await expect(sweepBugJournal({ rows: [failedRow()], ledger: { readAttempts: () => [] } as any })).resolves.toEqual({
      examined: 0,
      appended: 0,
      skipped: 0,
    })
  })

  it('one unwritable task never stops the pass', async () => {
    const dir = mkLedgerDir()
    const ledger = {
      ...mkLedger(dir),
      readAttempts: (id: string) => {
        if (id === 'R-1') throw new Error('файл реестра не читается')
        return []
      },
    }
    const summary = await sweepBugJournal({ rows: [failedRow(), failedRow({ id: 'R-3' })], ledger })
    expect(summary.appended).toBe(1)
    expect(readBugs(dir).map((r: any) => r.taskId)).toEqual(['R-3'])
  })
})

describe('the journal, read as numbers', () => {
  it('counts by reason and by project, and names both kinds of hole', () => {
    const totals = summarizeBugs([
      { taskId: 'R-1', project: 'sma', reason: 'manual', cause: 'turns_exhausted' },
      { taskId: 'R-2', project: 'sma-dev', reason: 'manual', cause: null },
      { taskId: 'R-3', project: null, reason: null, cause: null },
      { taskId: 'R-4', project: 'sma', reason: 'tests_red', cause: 'tests_red' },
    ])
    expect(totals.tasks).toBe(4)
    expect(totals.byReason).toEqual({ manual: 2, tests_red: 1, '(причина нигде не записана)': 1 })
    expect(totals.byProject).toEqual({ sma: 2, 'sma-dev': 1, '(проект не назван)': 1 })
    expect(totals.disagreed).toEqual(['R-1']) // the screen shows «manual» over a spent ceiling
    expect(totals.queueOnly).toEqual(['R-2']) // the only word lives on a row the queue archives
    expect(totals.silent).toEqual(['R-3'])
  })

  it('one task speaks once, with its latest line', () => {
    const totals = summarizeBugs([
      { taskId: 'R-1', project: 'sma', reason: 'tests_red', cause: 'tests_red' },
      { taskId: 'R-1', project: 'sma', reason: 'manual', cause: 'tests_red' },
    ])
    expect(totals.tasks).toBe(1)
    expect(totals.byReason).toEqual({ manual: 1 })
  })
})
