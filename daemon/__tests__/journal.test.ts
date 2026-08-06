/**
 * Tests for the decision journal — three layers on every attempt.
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
 *
 * ════════ PHASE 11 PLAN 05: THE ATTEMPT STAMP — THE WORLD AN ATTEMPT RAN IN ═══════
 * The same ledger, the same append-only law, seven more explicitly-picked fields (fleet
 * invariant 6): the policy version, the memory snapshot digest, the plan hash, the harness
 * version, the state-machine version, the idempotency key and the capability envelope's
 * digest. The cases live HERE rather than in a third file because they are cases about
 * `attempt-ledger.mjs`, which this suite already drives — the plan's own instruction.
 *
 * ════════ THE LIVE ATTEMPT LOG — the same ledger, the other tense ════════════════
 * The three layers explain an attempt after it decided something; the live log is every line
 * the worker printed, appended WHILE it printed them, so a screen can watch a running attempt
 * instead of a spinner. Its cases live here for the same reason the stamp's do: same dir,
 * same append-only law, same fail-open reader. What they pin:
 *   - two appends → two NDJSON rows in the ATTEMPT's own file; tail:1 → the last row and
 *     truncated:true; the tail is clamped (default 200, hard ceiling 1000);
 *   - a delegated line keeps {subagent, parentId}, an ordinary one carries neither;
 *   - FAIL-OPEN twice over: an fs that refuses everything, and a real path that is a file —
 *     `append` returns false, never throws, and complains exactly once;
 *   - the line is DATA: markup rides through verbatim, a newline can never split a row, and
 *     an over-long line is capped rather than refused.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
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
  attemptLogTail,
  ATTEMPT_LOG_LINE_CAP,
  ATTEMPT_LOG_TAIL_DEFAULT,
  ATTEMPT_LOG_TAIL_MAX,
} from '../src/front/journal.mjs'
import {
  appendJournalEntry,
  readJournalEntries,
  recordAttempt,
  readAttempts,
  memorySnapshotHash,
  MEMORY_SNAPSHOT_ABSENT,
  ALLOWED_ATTEMPT_KEYS,
  createAttemptLogWriter,
  readAttemptLog,
} from '../src/queue/attempt-ledger.mjs'
import { defaultEnvelope, envelopeHash } from '../src/queue/capability-envelope.mjs'
import { applyTransition, STATE_MACHINE_VERSION, idempotencyKey } from '../src/queue/state-machine.mjs'
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

describe('the dispatcher layer is written BY the router, at the decision', () => {
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
        // the conveyor's own switch ships OFF — a tick case that expects work says so
        pipeline: { enabled: true },
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

  it('holds NO in-process keyed collection (grep gate)', () => {
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

// ═══════ the attempt stamp — fleet invariant 6 ═════════

const NEW_STAMP_KEYS = [
  'policyVersion',
  'memorySnapshotHash',
  'planHash',
  'harnessVersion',
  'stateMachineVersion',
  'idempotencyKey',
  'capabilityEnvelopeHash',
]

describe('ALLOWED_ATTEMPT_KEYS — seven stamp fields, one provenance flag, every old one kept', () => {
  it('keeps every pre-existing member, in place', () => {
    const before = [
      'taskId',
      'attempt',
      'workerId',
      'provider',
      'startedAt',
      'endedAt',
      'outcome',
      'failureReason',
      'receiptRef',
    ]
    expect(ALLOWED_ATTEMPT_KEYS.slice(0, before.length)).toEqual(before)
  })

  it('gains exactly the seven stamp fields and stays frozen', () => {
    for (const k of NEW_STAMP_KEYS) expect(ALLOWED_ATTEMPT_KEYS).toContain(k)
    expect(ALLOWED_ATTEMPT_KEYS).toHaveLength(18)
    expect(Object.isFrozen(ALLOWED_ATTEMPT_KEYS)).toBe(true)
    expect(new Set(ALLOWED_ATTEMPT_KEYS).size).toBe(18) // no duplicate name
  })

  // The eighteenth key, added with the live attempt log. It is NOT a stamp field either: a
  // stamp says what the world was, this says which SESSION the work happened in — the one
  // thing about a finished attempt that cannot be recovered once the process is gone.
  it('carries sessionId, which is neither a stamp nor the provenance flag', () => {
    expect(ALLOWED_ATTEMPT_KEYS).toContain('sessionId')
    expect(NEW_STAMP_KEYS).not.toContain('sessionId')
    recordAttempt(dir, { taskId: 'BL-SESS', attempt: 1, outcome: 'completed', sessionId: 'sess-abc' })
    const [row] = readAttempts(dir, 'BL-SESS')
    expect(row.sessionId).toBe('sess-abc')
  })

  it('a row whose caller passed no session carries no sessionId key — absence, never an empty string', () => {
    recordAttempt(dir, { taskId: 'BL-NOSESS', attempt: 1, outcome: 'completed', sessionId: undefined })
    const [row] = readAttempts(dir, 'BL-NOSESS')
    expect(Object.hasOwn(row, 'sessionId')).toBe(false)
  })

  // The seventeenth key, added 2026-08-05 with the reconciliation pass. It
  // is NOT a stamp field: a stamp says what the world was, this says who wrote the row.
  it('carries the reconstructed flag LAST, after the stamp, so a reader can tell the two apart', () => {
    expect(ALLOWED_ATTEMPT_KEYS).toContain('reconstructed')
    expect(ALLOWED_ATTEMPT_KEYS[ALLOWED_ATTEMPT_KEYS.length - 1]).toBe('reconstructed')
    expect(NEW_STAMP_KEYS).not.toContain('reconstructed')
  })

  it('a live-recorded row does not carry the flag at all — absence is how a reader knows', () => {
    recordAttempt(dir, { taskId: 'BL-LIVE', attempt: 1, outcome: 'failed', failureReason: 'runtime_offline' })
    const [row] = readAttempts(dir, 'BL-LIVE')
    expect(Object.hasOwn(row, 'reconstructed')).toBe(false)
  })
})

describe('recordAttempt — the stamp is additive, and it rides the existing allowlist', () => {
  it('a call passing all seven writes all seven into the row', () => {
    const taskId = 'BL-S1'
    const env = defaultEnvelope('prod')
    const stamp = {
      policyVersion: 'routing-1',
      memorySnapshotHash: 'a'.repeat(64),
      planHash: 'b'.repeat(64),
      harnessVersion: 'claude-code-2.0.1',
      stateMachineVersion: STATE_MACHINE_VERSION,
      idempotencyKey: idempotencyKey(taskId, `${taskId}#1`, 'RUNNING->PRODUCED'),
      capabilityEnvelopeHash: envelopeHash(env),
    }
    recordAttempt(dir, { taskId, attempt: 1, outcome: 'completed', receiptRef: 'reverify:abc', ...stamp })
    const [row] = readAttempts(dir, taskId)
    for (const k of NEW_STAMP_KEYS) expect(row[k], k).toBe((stamp as any)[k])
  })

  it('a call passing NONE of them writes the row today’s readers already see (byte-identical)', () => {
    const taskId = 'BL-S2'
    const row = recordAttempt(dir, {
      taskId,
      attempt: 1,
      workerId: 'max-2',
      provider: 'claude',
      startedAt: '2026-08-04T10:00:00.000Z',
      endedAt: '2026-08-04T10:05:00.000Z',
      outcome: 'completed',
      receiptRef: 'reverify:abc',
      recordedAt: '2026-08-04T10:05:01.000Z',
    })
    expect(JSON.stringify(row)).toBe(
      '{"taskId":"BL-S2","attempt":1,"workerId":"max-2","provider":"claude",' +
        '"startedAt":"2026-08-04T10:00:00.000Z","endedAt":"2026-08-04T10:05:00.000Z",' +
        '"outcome":"completed","receiptRef":"reverify:abc","recordedAt":"2026-08-04T10:05:01.000Z"}',
    )
    for (const k of NEW_STAMP_KEYS) expect(row[k]).toBeUndefined()
  })

  it('a key OUTSIDE the allowlist is still dropped, exactly as before', () => {
    const taskId = 'BL-S3'
    recordAttempt(dir, {
      taskId,
      attempt: 1,
      outcome: 'completed',
      // @ts-expect-error — deliberately outside the allowlist
      promptText: 'СЕКРЕТНЫЙ текст задачи, которому нечего делать в леджере',
      apiKey: 'sk-not-a-real-key',
    })
    const raw = readFileSync(join(dir, `${taskId}.jsonl`), 'utf8')
    expect(raw).not.toContain('СЕКРЕТНЫЙ')
    expect(raw).not.toContain('sk-not-a-real-key')
    const [row] = readAttempts(dir, taskId)
    expect(row.promptText).toBeUndefined()
    expect(row.apiKey).toBeUndefined()
  })

  it('APPEND-ONLY: two calls for one task produce two rows, the first untouched', () => {
    const taskId = 'BL-S4'
    recordAttempt(dir, { taskId, attempt: 1, outcome: 'failed', failureReason: 'agent_error' })
    const first = readFileSync(join(dir, `${taskId}.jsonl`), 'utf8')
    recordAttempt(dir, { taskId, attempt: 2, outcome: 'completed', receiptRef: 'reverify:abc' })
    const rows = readAttempts(dir, taskId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r: any) => r.attempt)).toEqual([1, 2])
    expect(readFileSync(join(dir, `${taskId}.jsonl`), 'utf8').startsWith(first)).toBe(true)
  })

  it('derives capabilityEnvelopeHash from a passed envelope, and the ENVELOPE never lands on the row', () => {
    const taskId = 'BL-S5'
    const env = defaultEnvelope('forge')
    recordAttempt(dir, { taskId, attempt: 1, outcome: 'completed', capabilityEnvelope: env } as any)
    const [row] = readAttempts(dir, taskId)
    expect(row.capabilityEnvelopeHash).toBe(envelopeHash(env))
    expect(row.capabilityEnvelope).toBeUndefined()
    // no path from the envelope's declared write paths reaches the durable row
    const raw = readFileSync(join(dir, `${taskId}.jsonl`), 'utf8')
    expect(raw).not.toContain('.claude/agents')
  })

  it('an explicit capabilityEnvelopeHash wins over a passed envelope — the caller may stamp what actually ran', () => {
    const taskId = 'BL-S6'
    recordAttempt(dir, {
      taskId,
      attempt: 1,
      outcome: 'completed',
      capabilityEnvelope: defaultEnvelope('prod'),
      capabilityEnvelopeHash: 'c'.repeat(64),
    } as any)
    expect(readAttempts(dir, taskId)[0].capabilityEnvelopeHash).toBe('c'.repeat(64))
  })

  it('an applyTransition result records DIRECTLY: the version and the key ride in on it', () => {
    const taskId = 'BL-S7'
    const result: any = applyTransition({
      state: 'RUNNING',
      to: 'PRODUCED',
      actor: 'worker',
      taskId,
      attemptId: `${taskId}#1`,
      attempt: 1,
    })
    expect(result.applied).toBe(true)
    recordAttempt(dir, result)
    const [row] = readAttempts(dir, taskId)
    expect(row.stateMachineVersion).toBe(STATE_MACHINE_VERSION)
    expect(row.idempotencyKey).toBe(result.idempotencyKey)
    // the transition result's OTHER fields (contract, externalEffects, from) are not
    // allowlist members and never reach the durable row
    expect(row.contract).toBeUndefined()
    expect(row.externalEffects).toBeUndefined()
    expect(row.from).toBeUndefined()
  })

  it('the recorded digests carry no path separator and no note text', () => {
    const corpus = join(dir, 'corpus')
    mkdirSync(corpus, { recursive: true })
    writeFileSync(join(corpus, 'lesson.md'), '---\nid: lesson\n---\nСЕКРЕТНОЕ содержимое заметки\n')
    const taskId = 'BL-S8'
    recordAttempt(dir, {
      taskId,
      attempt: 1,
      outcome: 'completed',
      memorySnapshotHash: memorySnapshotHash({ corpusDir: corpus }),
      capabilityEnvelope: defaultEnvelope('prod'),
    } as any)
    const [row] = readAttempts(dir, taskId)
    for (const field of [row.memorySnapshotHash, row.capabilityEnvelopeHash]) {
      expect(field).toMatch(/^[0-9a-f]{64}$/)
      expect(field).not.toContain('/')
      expect(field).not.toContain('\\')
    }
    const raw = readFileSync(join(dir, `${taskId}.jsonl`), 'utf8')
    expect(raw).not.toContain('СЕКРЕТНОЕ')
    expect(raw).not.toContain('lesson.md')
    expect(raw).not.toContain(corpus)
  })
})

describe('memorySnapshotHash — what the worker knew, as a digest and nothing more', () => {
  const seed = () => {
    const corpus = join(dir, `corpus-${Math.random().toString(36).slice(2)}`)
    mkdirSync(corpus, { recursive: true })
    writeFileSync(join(corpus, 'a-rule.md'), '---\nid: a_rule\n---\nправило\n')
    writeFileSync(join(corpus, 'b-lesson.md'), '---\nid: b_lesson\n---\nурок\n')
    return corpus
  }

  it('two consecutive calls over an unchanged corpus return the same digest', () => {
    const corpus = seed()
    const first = memorySnapshotHash({ corpusDir: corpus })
    expect(memorySnapshotHash({ corpusDir: corpus })).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts a bare corpus path as well as the options object', () => {
    const corpus = seed()
    expect(memorySnapshotHash(corpus)).toBe(memorySnapshotHash({ corpusDir: corpus }))
  })

  it('editing a canonical record CHANGES the digest', () => {
    const corpus = seed()
    const before = memorySnapshotHash({ corpusDir: corpus })
    writeFileSync(join(corpus, 'b-lesson.md'), '---\nid: b_lesson\n---\nурок, переписанный\n')
    expect(memorySnapshotHash({ corpusDir: corpus })).not.toBe(before)
  })

  it('adding a canonical record changes it; renaming one changes it (the axis is name + content)', () => {
    const corpus = seed()
    const before = memorySnapshotHash({ corpusDir: corpus })
    writeFileSync(join(corpus, 'c-new.md'), '---\nid: c_new\n---\nновое\n')
    expect(memorySnapshotHash({ corpusDir: corpus })).not.toBe(before)
  })

  it('adding a GENERATED index file does NOT change it — a derived index is not knowledge', () => {
    const corpus = seed()
    const before = memorySnapshotHash({ corpusDir: corpus })
    writeFileSync(join(corpus, 'MEMORY.md'), '# CORE\n- generated index\n')
    writeFileSync(join(corpus, 'INDEX-tech.md'), '# tech\n- generated area index\n')
    writeFileSync(join(corpus, 'TAGS.md'), '# tags\n')
    writeFileSync(join(corpus, 'ARCHIVE.md'), '# archive\n')
    expect(memorySnapshotHash({ corpusDir: corpus })).toBe(before)
  })

  it('a MISSING corpus yields a declared absent value — never a throw, never a fabricated digest', () => {
    const missing = join(dir, 'no-such-corpus')
    expect(existsSync(missing)).toBe(false)
    const value = memorySnapshotHash({ corpusDir: missing })
    expect(value).toBe(MEMORY_SNAPSHOT_ABSENT)
    expect(value).not.toMatch(/^[0-9a-f]{64}$/)
    expect(memorySnapshotHash({} as any)).toBe(MEMORY_SNAPSHOT_ABSENT)
    expect(memorySnapshotHash(undefined as any)).toBe(MEMORY_SNAPSHOT_ABSENT)
  })

  it('a corpus holding only generated artifacts is ABSENT, not a digest of an empty world', () => {
    const corpus = join(dir, 'empty-corpus')
    mkdirSync(corpus, { recursive: true })
    expect(memorySnapshotHash({ corpusDir: corpus })).toBe(MEMORY_SNAPSHOT_ABSENT)
    writeFileSync(join(corpus, 'MEMORY.md'), '# CORE\n')
    expect(memorySnapshotHash({ corpusDir: corpus })).toBe(MEMORY_SNAPSHOT_ABSENT)
  })

  it('the digest carries no path, no file name and no note text', () => {
    const corpus = seed()
    const digest = memorySnapshotHash({ corpusDir: corpus })
    expect(digest).not.toContain('/')
    expect(digest).not.toContain('\\')
    expect(digest).not.toContain('a-rule')
    expect(digest).not.toContain('правило')
    expect(MEMORY_SNAPSHOT_ABSENT).not.toContain('/')
  })

  it('is stable across two corpora with identical content in different directories', () => {
    const one = seed()
    const two = seed()
    expect(memorySnapshotHash({ corpusDir: two })).toBe(memorySnapshotHash({ corpusDir: one }))
  })
})

// ═══════ the LIVE attempt log — the transcript, written while the worker still speaks ═══

describe('the live attempt log — every line, appended as it arrives', () => {
  const logFile = (attemptId: string) => join(dir, `${attemptId.replace(/[^A-Za-z0-9._-]/g, '_')}.log.ndjson`)

  it('two appends → two NDJSON rows in the attempt’s own file, in order', () => {
    const attemptId = attemptIdFor('BL-9', 1)
    const w = createAttemptLogWriter({ dir, attemptId })
    expect(w.append({ line: 'первая строка' })).toBe(true)
    expect(w.append({ line: 'вторая строка' })).toBe(true)

    const rows = readFileSync(logFile(attemptId), 'utf8').split('\n').filter((l) => l.trim())
    expect(rows).toHaveLength(2)
    const parsed = rows.map((r) => JSON.parse(r))
    expect(parsed.map((p) => p.line)).toEqual(['первая строка', 'вторая строка'])
    for (const p of parsed) expect(typeof p.ts).toBe('string')
  })

  it('reader with tail:1 → the LAST row and truncated:true (the older lines are said to exist)', () => {
    const attemptId = attemptIdFor('BL-9', 1)
    const w = createAttemptLogWriter({ dir, attemptId })
    w.append({ line: 'one' })
    w.append({ line: 'two' })

    const tailed = readAttemptLog({ dir, attemptId, tail: 1 })
    expect(tailed.entries).toHaveLength(1)
    expect(tailed.entries[0].line).toBe('two')
    expect(tailed.total).toBe(2)
    expect(tailed.truncated).toBe(true)

    const whole = readAttemptLog({ dir, attemptId })
    expect(whole.entries).toHaveLength(2)
    expect(whole.truncated).toBe(false)
  })

  it('a subagent line keeps its flag and its opaque parent id; an ordinary line carries neither', () => {
    const attemptId = attemptIdFor('BL-9', 2)
    const w = createAttemptLogWriter({ dir, attemptId })
    w.append({ line: 'main session', subagent: false })
    w.append({ line: 'delegated text', subagent: true, parentId: 'toolu_01ABC' })

    const { entries } = readAttemptLog({ dir, attemptId })
    expect('subagent' in entries[0]).toBe(false) // absent, not false — the row stays two fields wide
    expect(entries[1].subagent).toBe(true)
    expect(entries[1].parentId).toBe('toolu_01ABC')
  })

  it('FAIL-OPEN: a filesystem that refuses every write never throws — append says false, complained once', () => {
    const complaints: any[] = []
    const angryFs = {
      mkdirSync: () => {
        throw new Error('EACCES: permission denied')
      },
      appendFileSync: () => {
        throw new Error('EACCES: permission denied')
      },
    }
    let w: any
    expect(() => {
      w = createAttemptLogWriter({ dir, attemptId: 'BL-9#3', fsImpl: angryFs, onError: (e: any) => complaints.push(e) })
    }).not.toThrow()
    expect(() => w.append({ line: 'x' })).not.toThrow()
    expect(w.append({ line: 'x' })).toBe(false)
    expect(w.append({ line: 'y' })).toBe(false)
    expect(complaints).toHaveLength(1) // one failure is reported ONCE, not once per line
  })

  it('FAIL-OPEN over a REAL unreachable directory — a path that is a file, not a dir', () => {
    const notADir = join(dir, 'a-file')
    writeFileSync(notADir, 'i am a file')
    const w = createAttemptLogWriter({ dir: join(notADir, 'nested'), attemptId: 'BL-9#4' })
    expect(() => w.append({ line: 'x' })).not.toThrow()
    expect(w.append({ line: 'x' })).toBe(false)
  })

  it('a writer with no dir or no attemptId is a working no-op, so no caller needs a null check', () => {
    for (const bad of [{}, { dir }, { attemptId: 'BL-9#5' }]) {
      const w = createAttemptLogWriter(bad as any)
      expect(() => w.append({ line: 'x' })).not.toThrow()
      expect(w.append({ line: 'x' })).toBe(false)
    }
  })

  it('a missing log reads as an EMPTY log, and a corrupt row is skipped rather than thrown', () => {
    expect(readAttemptLog({ dir, attemptId: 'BL-NOBODY#1' })).toEqual({
      attemptId: 'BL-NOBODY#1',
      entries: [],
      total: 0,
      truncated: false,
    })

    const attemptId = 'BL-9#6'
    const w = createAttemptLogWriter({ dir, attemptId })
    w.append({ line: 'good' })
    appendFileSync(logFile(attemptId), '{ this is not json\n')
    w.append({ line: 'also good' })
    const { entries, total } = readAttemptLog({ dir, attemptId })
    expect(total).toBe(2)
    expect(entries.map((e: any) => e.line)).toEqual(['good', 'also good'])
  })

  it('the tail is clamped: an absurd ask is capped at 1000, a nonsense ask falls back to 200', () => {
    const huge = Array.from({ length: 1500 }, (_, i) => ({ line: String(i) }))
    expect(attemptLogTail(huge, 99_999).entries).toHaveLength(ATTEMPT_LOG_TAIL_MAX)
    expect(ATTEMPT_LOG_TAIL_MAX).toBe(1000)
    const many = Array.from({ length: 500 }, (_, i) => ({ line: String(i) }))
    expect(attemptLogTail(many, undefined).entries).toHaveLength(ATTEMPT_LOG_TAIL_DEFAULT)
    expect(attemptLogTail(many, -5).entries).toHaveLength(ATTEMPT_LOG_TAIL_DEFAULT)
    expect(ATTEMPT_LOG_TAIL_DEFAULT).toBe(200)
  })

  it('the line is DATA: markup rides through verbatim, is capped, and never splits a row', () => {
    const attemptId = 'BL-9#7'
    const w = createAttemptLogWriter({ dir, attemptId })
    w.append({ line: '<script>alert(1)</script> & <b>bold</b>' })
    w.append({ line: 'a\nb\nc' }) // a newline can never split an NDJSON row
    w.append({ line: 'x'.repeat(ATTEMPT_LOG_LINE_CAP + 500) })

    const rawRows = readFileSync(logFile(attemptId), 'utf8').split('\n').filter((l) => l.trim())
    expect(rawRows).toHaveLength(3)
    const { entries } = readAttemptLog({ dir, attemptId })
    expect(entries[0].line).toBe('<script>alert(1)</script> & <b>bold</b>') // NOT escaped, NOT stripped
    expect(entries[1].line).toBe('a b c')
    expect(entries[2].line).toHaveLength(ATTEMPT_LOG_LINE_CAP)
  })

  it('the transcript is PER ATTEMPT: a retry writes its own file and cannot overwrite the first', () => {
    const first = attemptIdFor('BL-9', 1)
    const second = attemptIdFor('BL-9', 2)
    createAttemptLogWriter({ dir, attemptId: first }).append({ line: 'attempt one' })
    createAttemptLogWriter({ dir, attemptId: second }).append({ line: 'attempt two' })
    expect(readAttemptLog({ dir, attemptId: first }).entries[0].line).toBe('attempt one')
    expect(readAttemptLog({ dir, attemptId: second }).entries[0].line).toBe('attempt two')
    expect(existsSync(logFile(first))).toBe(true)
    expect(existsSync(logFile(second))).toBe(true)
  })
})

describe('the ledger keeps its stated disciplines', () => {
  const ledgerSrc = readFileSync(new URL('../src/queue/attempt-ledger.mjs', import.meta.url), 'utf8')

  it('exposes only append and read functions — no rewrite, no delete', () => {
    const exported = [...ledgerSrc.matchAll(/^export function (\w+)/gm)].map((m) => m[1])
    expect(exported.sort()).toEqual(
      [
        'appendJournalEntry',
        'memorySnapshotHash',
        'readAttempts',
        'readJournalEntries',
        'recordAttempt',
        // the live attempt log: a writer that only appends and a reader that only reads
        'createAttemptLogWriter',
        'readAttemptLog',
      ].sort(),
    )
    for (const forbidden of ['unlinkSync', 'rmSync', 'writeFileSync', 'truncateSync']) {
      expect(ledgerSrc).not.toContain(forbidden)
    }
  })

  it('builds the row through the allowlist loop only — no spread, no passthrough', () => {
    expect(ledgerSrc).toContain('for (const k of ALLOWED_ATTEMPT_KEYS) if (attempt[k] !== undefined) row[k] = attempt[k]')
    expect(ledgerSrc).not.toMatch(/row\s*=\s*\{\s*\.\.\.attempt/)
  })
})
