/**
 * Tests for the decision journal — three layers on every attempt (D-9.7-14).
 *
 * The law under test: an attempt is not complete until it EXPLAINS itself.
 *   (a) dispatcher — why the router picked this lane/worker, as a CODE from a closed
 *       vocabulary written at the moment of the decision (never narrated afterwards);
 *   (b) approach   — the worker's note: what was chosen, what was rejected, what
 *       influenced it. Mandatory exactly like a receipt is mandatory;
 *   (c) memory     — which notes were loaded and which reflexes fired: IDS ONLY.
 *
 * Everything rides the EXISTING per-task attempt ledger (append-only JSONL, one file per
 * task) — no new store. The suite drives a real temp dir (real append semantics are the
 * point: a rewrite must be impossible, not merely unused).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JOURNAL_LAYERS,
  DISPATCH_REASONS,
  APPROACH_NOTE_CAP,
  attemptIdFor,
  readJournal,
  journalComplete,
  parseApproachNote,
} from '../src/front/journal.mjs'
import { appendJournalEntry, readJournalEntries, recordAttempt, readAttempts } from '../src/queue/attempt-ledger.mjs'

let dir: string
let ledger: any
const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-journal-'))
  ledger = { readJournalEntries: (taskId: string) => readJournalEntries(dir, taskId) }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const journalFile = (taskId: string) => join(dir, `${taskId}.journal.jsonl`)
const lines = (taskId: string) =>
  readFileSync(journalFile(taskId), 'utf8')
    .split('\n')
    .filter((l) => l.trim())

describe('the closed vocabularies (frozen, code + RU подпись)', () => {
  it('JOURNAL_LAYERS is exactly the three layers and is frozen', () => {
    expect(JOURNAL_LAYERS).toEqual(['dispatcher', 'approach', 'memory'])
    expect(Object.isFrozen(JOURNAL_LAYERS)).toBe(true)
  })

  it('DISPATCH_REASONS is frozen and every code carries a non-empty RU подпись', () => {
    expect(Object.isFrozen(DISPATCH_REASONS)).toBe(true)
    const codes = Object.keys(DISPATCH_REASONS)
    expect(codes.length).toBeGreaterThanOrEqual(6)
    for (const code of codes) {
      expect(typeof DISPATCH_REASONS[code]).toBe('string')
      expect(DISPATCH_REASONS[code].length).toBeGreaterThan(0)
    }
    // the outcomes the router must be able to name
    for (const required of ['window_exhausted', 'api_fallback_requested', 'lane_default']) {
      expect(codes).toContain(required)
    }
  })
})

describe('appendJournalEntry — three layers, strictly appended', () => {
  it('records each layer and readJournal aggregates them per attempt in time order', () => {
    const c = mkClock()
    const taskId = 'BL-7'
    appendJournalEntry(dir, {
      taskId,
      attempt: 1,
      layer: 'dispatcher',
      payload: { code: 'lane_default', lane: 'prod', workerId: 'max-2' },
      clock: c.clock,
    })
    c.advance(1000)
    appendJournalEntry(dir, {
      taskId,
      attempt: 1,
      layer: 'memory',
      payload: { notes: ['reference_sma_ledger'], reflexes: ['reflex_no_push'] },
      clock: c.clock,
    })
    c.advance(1000)
    appendJournalEntry(dir, {
      taskId,
      attempt: 1,
      layer: 'approach',
      payload: { approach: 'сделал через существующий леджер', rejected: ['новое хранилище'], influences: ['rule_zero_dep'] },
      clock: c.clock,
    })

    const j = readJournal({ taskId, ledger })
    expect(j.taskId).toBe(taskId)
    expect(j.entries).toHaveLength(3)
    expect(j.entries.map((e: any) => e.layer)).toEqual(['dispatcher', 'memory', 'approach']) // time order
    expect(j.attempts).toHaveLength(1)
    const [a] = j.attempts
    expect(a.attemptId).toBe(attemptIdFor(taskId, 1))
    expect(a.dispatcher[0].payload.code).toBe('lane_default')
    expect(a.approach[0].payload.approach).toContain('леджер')
    expect(a.memory[0].payload.notes).toEqual(['reference_sma_ledger'])
  })

  it('groups several attempts of one task, ordered by attempt', () => {
    const taskId = 'BL-8'
    appendJournalEntry(dir, { taskId, attempt: 2, layer: 'dispatcher', payload: { code: 'window_exhausted' } })
    appendJournalEntry(dir, { taskId, attempt: 1, layer: 'dispatcher', payload: { code: 'lane_default' } })
    const j = readJournal({ taskId, ledger })
    expect(j.attempts.map((a: any) => a.attempt)).toEqual([1, 2])
  })

  it('APPEND-ONLY: two writes leave exactly two lines and the first row is untouched', () => {
    const taskId = 'BL-9'
    appendJournalEntry(dir, { taskId, attempt: 1, layer: 'dispatcher', payload: { code: 'lane_default' } })
    const first = lines(taskId)[0]
    appendJournalEntry(dir, { taskId, attempt: 1, layer: 'dispatcher', payload: { code: 'window_exhausted' } })
    const after = lines(taskId)
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(first) // byte-identical — history is never rewritten
  })

  it('the journal is a sibling file: attempt rows stay exactly as they were (no reader breaks)', () => {
    const taskId = 'BL-10'
    recordAttempt(dir, { taskId, attempt: 1, outcome: 'completed', receiptRef: 'reverify:abc' })
    appendJournalEntry(dir, { taskId, attempt: 1, layer: 'dispatcher', payload: { code: 'lane_default' } })
    const rows = readAttempts(dir, taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('completed')
    expect(rows[0].layer).toBeUndefined()
  })

  it('refuses a layer outside the closed set and a dispatcher code outside the vocabulary', () => {
    const taskId = 'BL-11'
    expect(() => appendJournalEntry(dir, { taskId, attempt: 1, layer: 'gossip', payload: {} })).toThrow(/layer/i)
    expect(() =>
      appendJournalEntry(dir, { taskId, attempt: 1, layer: 'dispatcher', payload: { code: 'because I felt like it' } }),
    ).toThrow(/code/i)
    // nothing was written by a refused call
    expect(existsSync(journalFile(taskId))).toBe(false)
  })

  it('the dispatcher layer carries NO free text — unknown keys never reach the row', () => {
    const taskId = 'BL-12'
    appendJournalEntry(dir, {
      taskId,
      attempt: 1,
      layer: 'dispatcher',
      payload: { code: 'lane_default', lane: 'prod', commentary: 'мне показалось, что так лучше' },
    })
    const raw = lines(taskId)[0]
    expect(raw).not.toContain('показалось')
    const [row] = readJournalEntries(dir, taskId)
    expect(row.payload.commentary).toBeUndefined()
    expect(row.payload.code).toBe('lane_default')
  })

  it('truncates an oversized approach note instead of losing the attempt, and marks it truncated', () => {
    const taskId = 'BL-13'
    appendJournalEntry(dir, {
      taskId,
      attempt: 1,
      layer: 'approach',
      payload: { approach: 'я'.repeat(APPROACH_NOTE_CAP + 500) },
    })
    const [row] = readJournalEntries(dir, taskId)
    expect(row.payload.approach.length).toBe(APPROACH_NOTE_CAP)
    expect(row.payload.truncated).toBe(true)
  })

  it('refuses an empty approach note (an empty note is not a note)', () => {
    expect(() => appendJournalEntry(dir, { taskId: 'BL-14', attempt: 1, layer: 'approach', payload: { approach: '   ' } })).toThrow(
      /approach/i,
    )
  })

  it('the memory layer keeps IDS and drops note CONTENT', () => {
    const taskId = 'BL-15'
    appendJournalEntry(dir, {
      taskId,
      attempt: 1,
      layer: 'memory',
      payload: {
        notes: ['reference_sma_ledger', 'СЕКРЕТНОЕ содержимое заметки, целый абзац текста который тут не должен оказаться'],
        reflexes: ['reflex_no_push'],
      },
    })
    const raw = lines(taskId)[0]
    expect(raw).not.toContain('СЕКРЕТНОЕ')
    const [row] = readJournalEntries(dir, taskId)
    expect(row.payload.notes).toEqual(['reference_sma_ledger'])
    expect(row.payload.reflexes).toEqual(['reflex_no_push'])
  })
})

describe('journalComplete — the predicate the pipeline gates on', () => {
  it('is false without an approach note and true with one', () => {
    const taskId = 'BL-16'
    appendJournalEntry(dir, { taskId, attempt: 1, layer: 'dispatcher', payload: { code: 'lane_default' } })
    expect(journalComplete({ taskId, attempt: 1, ledger })).toBe(false)
    appendJournalEntry(dir, { taskId, attempt: 1, layer: 'approach', payload: { approach: 'взял простой путь' } })
    expect(journalComplete({ taskId, attempt: 1, ledger })).toBe(true)
  })

  it('is per-attempt: attempt 2 is not covered by attempt 1 note', () => {
    const taskId = 'BL-17'
    appendJournalEntry(dir, { taskId, attempt: 1, layer: 'approach', payload: { approach: 'первый подход' } })
    expect(journalComplete({ attemptId: attemptIdFor(taskId, 1), taskId, ledger })).toBe(true)
    expect(journalComplete({ taskId, attempt: 2, ledger })).toBe(false)
  })
})

describe('backward compatibility — a task from before this revision', () => {
  it('readJournal on a task with no journal returns empty layers, never throws', () => {
    const j = readJournal({ taskId: 'BL-OLD', ledger })
    expect(j.entries).toEqual([])
    expect(j.attempts).toEqual([])
  })

  it('journalComplete on a task with no journal is false, never throws', () => {
    expect(journalComplete({ taskId: 'BL-OLD', attempt: 1, ledger })).toBe(false)
  })

  it('a corrupt journal line is skipped, not thrown (fail-open reader, same as attempt rows)', () => {
    const taskId = 'BL-18'
    appendJournalEntry(dir, { taskId, attempt: 1, layer: 'dispatcher', payload: { code: 'lane_default' } })
    // simulate a torn write by appending garbage through the same append primitive
    appendFileSync(journalFile(taskId), '{not json\n')
    expect(readJournalEntries(dir, taskId)).toHaveLength(1)
  })
})

describe('parseApproachNote — the worker-side protocol the loop reads off the stream', () => {
  it('reads the approach, the rejected alternatives and the influences', () => {
    const note = parseApproachNote([
      'some ordinary output',
      'APPROACH_NOTE: расширил существующий леджер',
      'APPROACH_REJECTED: новое хранилище',
      'APPROACH_REJECTED: колонка в очереди',
      'APPROACH_INFLUENCES: rule_zero_dep',
    ])
    expect(note.approach).toBe('расширил существующий леджер')
    expect(note.rejected).toEqual(['новое хранилище', 'колонка в очереди'])
    expect(note.influences).toEqual(['rule_zero_dep'])
  })

  it('returns null when the worker left no note', () => {
    expect(parseApproachNote(['just output', 'no note here'])).toBeNull()
  })
})
