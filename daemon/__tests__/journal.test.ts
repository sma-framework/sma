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
  APPROACH_MARKERS,
  attemptIdFor,
  readJournal,
  journalComplete,
  parseApproachNote,
} from '../src/front/journal.mjs'
import { appendJournalEntry, readJournalEntries, recordAttempt, readAttempts } from '../src/queue/attempt-ledger.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { buildTaskPrompt } from '../src/runner/args.mjs'
import { tick, classifyFailure } from '../src/loop.mjs'
import { createMemoryQueue, FAIL_REASONS, REASON_LABELS } from '../src/queue/adapter.mjs'

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

describe('the dispatcher layer is written BY the router, at the decision (D-9.7-14)', () => {
  const worker = { id: 'max-2', lane: 'prod', provider: 'claude', enabled: true, account: { configDir: '/x' } }
  const nightClock = () => new Date('2026-07-21T03:00:00').getTime() // outside active hours

  const route = (task: any, over: any = {}) => {
    const written: any[] = []
    const decision = resolveRoute(task, {
      workers: [worker],
      windows: () => true,
      clock: nightClock,
      config: {},
      decisionJournal: (e: any) => written.push(e),
      ...over,
    })
    return { decision, written }
  }

  const outcomes: Array<[string, any, any, string]> = [
    ['lane default → lane_default', { id: 'BL-A', lane: 'prod' }, {}, 'lane_default'],
    ['per-task override → per_task_override', { id: 'BL-B', lane: 'prod', model: 'opus' }, {}, 'per_task_override'],
    [
      'per-worker override → per_worker_override',
      { id: 'BL-C', lane: 'prod' },
      { workers: [{ ...worker, model: 'sonnet' }] },
      'per_worker_override',
    ],
    ['explicit api → api_fallback_requested', { id: 'BL-D', lane: 'prod', provider: 'api' }, {}, 'api_fallback_requested'],
    ['no open window → window_exhausted', { id: 'BL-E', lane: 'prod' }, { windows: () => false }, 'window_exhausted'],
    [
      'the founder’s protected account during active hours → day_priority_protected',
      { id: 'BL-F', lane: 'prod' },
      { workers: [{ ...worker, dayPriorityOwner: true }], clock: () => new Date('2026-07-21T12:00:00').getTime() },
      'day_priority_protected',
    ],
  ]

  for (const [name, task, over, code] of outcomes) {
    it(`${name} — the code is on the decision AND in the journal`, () => {
      const { decision, written } = route(task, over)
      expect(decision.reasonCode).toBe(code)
      expect(Object.keys(DISPATCH_REASONS)).toContain(code)
      expect(written).toHaveLength(1)
      expect(written[0].layer).toBe('dispatcher')
      expect(written[0].taskId).toBe(task.id)
      expect(written[0].payload.code).toBe(code)
    })
  }

  it('every routing outcome code exists in the closed vocabulary and is renderable', () => {
    for (const [, task, over, code] of outcomes) {
      route(task, over)
      expect(typeof DISPATCH_REASONS[code]).toBe('string')
    }
  })

  it('a lane PROBE (no task id) writes nothing — the tick asks routing many times per tick', () => {
    const { written } = route({ lane: 'prod' })
    expect(written).toHaveLength(0)
  })

  it('a throwing journal sink never breaks routing (fail-open)', () => {
    const decision = resolveRoute(
      { id: 'BL-G', lane: 'prod' },
      {
        workers: [worker],
        windows: () => true,
        clock: nightClock,
        config: {},
        decisionJournal: () => {
          throw new Error('disk on fire')
        },
      },
    )
    expect(decision.workerId).toBe('max-2')
  })
})

describe('the approach note is part of the task prompt contract', () => {
  it('buildTaskPrompt demands the note, names its markers, and still fences task DATA', () => {
    const prompt = buildTaskPrompt({ task: { id: 'BL-1', title: 'do it', note: 'from the founder' } })
    expect(prompt).toContain(APPROACH_MARKERS.approach)
    expect(prompt).toContain(APPROACH_MARKERS.rejected)
    expect(prompt).toContain(APPROACH_MARKERS.influences)
    expect(prompt).toMatch(/записк/i)
    expect(prompt).toContain('```task') // untrusted task data still rides the fence
  })
})

describe('the completion gate asks for the note where it asks for the receipt', () => {
  const backlogTask = (over: any = {}) => ({
    id: 'BL-J1',
    source: 'backlog',
    title: 'do the thing',
    lane: 'prod',
    priority: 0,
    storyPoints: 3,
    acceptance: 'green targeted tests + a reverify receipt',
    ...over,
  })

  const GREEN_REVERIFY = {
    code: 0,
    stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }),
  }

  function makeDeps(adapter: any, streamLines: string[], over: any = {}) {
    const written: any[] = []
    const deps: any = {
      adapter,
      ledger: { recordAttempt: () => {}, readAttempts: () => [] },
      config: {
        workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
        repoDir: '/repo',
        ...over.config,
      },
      routing: { resolveRoute },
      windows: () => true,
      buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
      verbRunner: async (_bin: string, argsArray: string[]) => {
        const verb = argsArray[1]
        if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
        if (verb === 'worktree') return { code: 0, stdout: JSON.stringify({ worktreePath: '/wt/x' }) }
        if (verb === 'reverify') return GREEN_REVERIFY
        return { code: 0, stdout: '{}' }
      },
      spawnWorker: (spec: any) => {
        for (const l of streamLines) spec.onLine?.(l)
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 1, kill: () => {} }
      },
      clock: () => new Date('2026-07-21T03:00:00').getTime(),
      decisionJournal: (e: any) => written.push(e),
      ...over.deps,
    }
    return { deps, written }
  }

  it('a green receipt WITHOUT an approach note does NOT complete — it fails "no_journal"', async () => {
    const adapter = createMemoryQueue({ clock: () => Date.now(), expireMs: 300000 })
    await adapter.enqueue(backlogTask())
    const { deps } = makeDeps(adapter, ['ordinary output, no note'])

    const res = await tick(deps)

    expect(res.completed).toBeUndefined()
    expect(res.failed).toEqual({ taskId: 'BL-J1', reason: 'no_journal' })
    const [row] = await adapter.list({})
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('no_journal')
  })

  it('the same attempt WITH a note completes, and the note lands in the journal as data', async () => {
    const adapter = createMemoryQueue({ clock: () => Date.now(), expireMs: 300000 })
    await adapter.enqueue(backlogTask({ id: 'BL-J2' }))
    const { deps, written } = makeDeps(adapter, [
      'working…',
      'APPROACH_NOTE: расширил существующий леджер вместо нового хранилища',
      'APPROACH_REJECTED: новое хранилище журнала',
      'APPROACH_INFLUENCES: rule_zero_dep',
    ])

    const res = await tick(deps)

    expect(res.completed).toBe('BL-J2')
    const approach = written.filter((e) => e.layer === 'approach')
    expect(approach).toHaveLength(1)
    expect(approach[0].taskId).toBe('BL-J2')
    expect(approach[0].payload.approach).toContain('леджер')
    expect(approach[0].payload.rejected).toEqual(['новое хранилище журнала'])
  })

  it('no_journal is a first-class failure reason with a RU подпись', () => {
    expect(FAIL_REASONS).toContain('no_journal')
    expect(typeof REASON_LABELS.no_journal).toBe('string')
    expect(REASON_LABELS.no_journal.length).toBeGreaterThan(0)
  })

  it('classifyFailure names a missing note only once the receipt is green', () => {
    expect(classifyFailure({ exitCode: 0, receipt: { verdict: 'green', ref: 'r' }, journalComplete: false })).toBe('no_journal')
    expect(classifyFailure({ exitCode: 0, receipt: { verdict: 'green', ref: 'r' }, journalComplete: true })).toBe('agent_error')
    // a missing receipt still beats a missing note — the older law is not weakened
    expect(classifyFailure({ exitCode: 0, receipt: null, journalComplete: false })).toBe('no_receipt')
  })

  it('the memory trace is written from the worker-context load: IDS only, no content', async () => {
    const adapter = createMemoryQueue({ clock: () => Date.now(), expireMs: 300000 })
    await adapter.enqueue(backlogTask({ id: 'BL-J3' }))
    const { deps, written } = makeDeps(adapter, ['APPROACH_NOTE: сделал прямо'], {
      config: {
        workers: [
          {
            id: 'max-2',
            lane: 'prod',
            provider: 'claude',
            account: { configDir: '/x' },
            enabled: true,
            roleFile: '.claude/agents/builder.md',
            skills: ['sma-debug', 'sma-quick'],
          },
        ],
        repoDir: '/repo',
      },
      deps: {
        resolveWorkerContext: () => ({ rolePreamble: 'ТЫ СТРОИТЕЛЬ. Секретный текст роли.', skillsList: ['sma-debug', 'sma-quick'] }),
      },
    })

    await tick(deps)

    const memory = written.filter((e) => e.layer === 'memory')
    expect(memory).toHaveLength(1)
    expect(memory[0].payload.notes).toContain('.claude/agents/builder.md')
    expect(memory[0].payload.reflexes).toEqual(['sma-debug', 'sma-quick'])
    expect(JSON.stringify(memory[0])).not.toContain('Секретный')
  })

  it('a throwing journal sink never wedges the tick (fail-open, merge-gate posture)', async () => {
    const adapter = createMemoryQueue({ clock: () => Date.now(), expireMs: 300000 })
    await adapter.enqueue(backlogTask({ id: 'BL-J4' }))
    const { deps } = makeDeps(adapter, ['APPROACH_NOTE: сделал прямо'], {
      deps: {
        decisionJournal: () => {
          throw new Error('disk on fire')
        },
      },
    })
    const res = await tick(deps)
    expect(res.completed).toBe('BL-J4')
  })
})

describe('the tick file keeps its disciplines', () => {
  const src = readFileSync(new URL('../src/loop.mjs', import.meta.url), 'utf8')

  it('holds NO in-process keyed collection (D-9.5-02 grep gate)', () => {
    expect(src).not.toMatch(/new Map\b/)
    expect(src).not.toMatch(/new Set\b/)
  })

  it('never writes the reserved push literal (SMA-3 comment discipline)', () => {
    expect(src.toLowerCase()).not.toMatch(/git\s+push/)
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
