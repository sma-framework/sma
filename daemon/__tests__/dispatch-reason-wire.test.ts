/**
 * THE REASON CODE, ALL THE WAY TO THE FILE — and the word that never got there.
 *
 * `dispatch-vocabulary-lock.test.ts` says, in its own header, what it cannot see: two call
 * sites hand the journal sink a VARIABLE rather than a literal, and «those two are covered by
 * the wire test beside this file». One of them was — the money rule's verdict, in
 * `budget-wire.test.ts`. The other one, the wait code chosen a line earlier, was not, and the
 * hole it hid was not a gap in coverage but a break in the wire: the router named
 * `worker_busy`, the closed vocabulary did not carry that word, and the sink drops silently
 * what it cannot sign. The decision «every seat is taken» was made, acted on, and never
 * recorded — the card said the route was never decided. This file is the missing half of that
 * sentence, and the word is now in the vocabulary.
 *
 * WHAT THIS FILE ADDS THAT THE NEIGHBOURS DO NOT HAVE, said plainly so nothing is duplicated:
 *
 *   - `journal.test.ts` (describe «the dispatcher layer is written BY the router, at the
 *     decision») drives the real router over six outcomes, and `budget-wire.test.ts` over the
 *     two money words. Both stop at an INJECTED SINK — an array in memory. That proves the
 *     router calls somebody. It does not prove a row exists on disk, because the sink they
 *     use is not the one production uses: the real one normalizes the payload against the
 *     same closed vocabulary a second time and can refuse. Here the sink is the shipped
 *     `appendJournalEntry`, the dir is a real temp dir, and the assertion reads the FILE.
 *   - Neither of them drives the busy branch at all, which is where the broken word lived.
 *   - Neither of them asks the router whether it dropped anything: `unknownReasonSink` is the
 *     product's own counter for a code nobody could sign, and a wire test that never consults
 *     it would have stayed green through the whole defect. It is consulted on every case.
 *   - The exact composition of the vocabulary is written out here word for word, as a second
 *     yardstick. `journal.test.ts` pins that the set is frozen, that every подпись is
 *     non-empty and that three names are present; it deliberately does NOT pin the whole
 *     list, so those assertions are not repeated here — this file pins the list and the
 *     count, and widening the vocabulary has to be RETYPED here to stay green.
 *
 * THE LAST DESCRIBE IS NOT ABOUT THE DAEMON. It reads `docs/FLEET-INVARIANTS.md` and requires
 * the two intentions §5.9 and §5.10 record — no governance for roles that start work on a
 * clock, no fan-out measurement and no post-hoc scoring — to still be in it. A decision
 * written as prose rots silently; a decision an assertion reads cannot vanish in a merge
 * without somebody being told.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DISPATCH_REASONS } from '../src/front/journal.mjs'
import { appendJournalEntry } from '../src/queue/attempt-ledger.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Outside the founder's active hours — the protected-account branch must not fire here. */
const NIGHT = () => new Date('2026-07-21T03:00:00').getTime()

const WORKER = { id: 'max-2', lane: 'prod', provider: 'claude', enabled: true, account: { configDir: '/x' } }

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sma-dispatch-wire-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const journalPath = (taskId: string) => join(dir, `${taskId}.journal.jsonl`)

const journalRows = (taskId: string): any[] =>
  readFileSync(journalPath(taskId), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

/**
 * The router, wired to the SHIPPED journal writer over a real directory — no array, no fake.
 * `dropped` collects everything the product's own orphan counter was told about.
 */
function routeThroughTheLedger(task: any, over: any = {}) {
  const dropped: string[] = []
  const decision = resolveRoute(task, {
    workers: [WORKER],
    windows: () => true,
    clock: NIGHT,
    config: {},
    decisionJournal: (entry: any) => appendJournalEntry(dir, entry),
    unknownReasonSink: (code: string) => dropped.push(code),
    ...over,
  })
  return { decision, dropped }
}

describe('the dispatcher vocabulary, named word for word', () => {
  /**
   * The list is a deliberate second yardstick: it is typed out, not derived. Changing the
   * shipped vocabulary must cost a retype here, because that retype is the moment somebody
   * decides whether the new word is a word this product wants to say.
   */
  const CANON = [
    'per_task_override',
    'per_worker_override',
    'lane_default',
    'api_fallback_requested',
    'api_fallback',
    'window_exhausted',
    'day_priority_protected',
    'worker_busy',
    'wait_for_window',
    'budget_stop',
    'api_cap_unset',
    'budget_declined',
  ]

  it('carries exactly these twelve codes, in this order', () => {
    expect(Object.keys(DISPATCH_REASONS)).toEqual(CANON)
    expect(Object.keys(DISPATCH_REASONS)).toHaveLength(12)
  })

  it('carries a подпись for the busy seat — the word the router used before anyone could sign it', () => {
    expect(typeof DISPATCH_REASONS.worker_busy).toBe('string')
    expect(DISPATCH_REASONS.worker_busy.length).toBeGreaterThan(0)
  })
})

describe('the reason code reaches the task journal FILE, at the decision', () => {
  const cases: Array<[string, any, any, string]> = [
    ['a worker was selected on the lane default', { id: 'BL-W1', attempt: 1, lane: 'prod' }, {}, 'lane_default'],
    [
      'every seat is taken by work already running',
      { id: 'BL-W2', attempt: 1, lane: 'prod' },
      { busyWorkers: new Set([WORKER.id]) },
      'worker_busy',
    ],
    [
      'no window is open anywhere',
      { id: 'BL-W3', attempt: 1, lane: 'prod' },
      { windows: () => false, budget: () => null },
      'window_exhausted',
    ],
  ]

  for (const [name, task, over, code] of cases) {
    it(`${name} — the code is on the row on disk, not merely on the answer`, () => {
      // Nothing exists yet: without this the assertion below could be reading a file some
      // earlier case left behind.
      expect(existsSync(journalPath(task.id))).toBe(false)

      const { decision, dropped } = routeThroughTheLedger(task, over)

      expect(decision.reasonCode).toBe(code)

      // AT THE DECISION: the call is synchronous and nothing is awaited between it and this
      // line, so a row that is not here now is a row written afterwards, by somebody else.
      expect(existsSync(journalPath(task.id)), 'the decision left no journal file').toBe(true)
      const rows = journalRows(task.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].layer).toBe('dispatcher')
      expect(rows[0].taskId).toBe(task.id)
      expect(rows[0].payload.code).toBe(code)
      expect(rows[0].payload.lane).toBe('prod')

      // The подпись a card renders is derivable from the row — the row stores the code.
      expect(typeof DISPATCH_REASONS[rows[0].payload.code]).toBe('string')

      // AND NOTHING FELL OFF THE WIRE. This is the assertion whose absence let the busy word
      // stay unrecorded for as long as it did: the route answered, the journal was silent,
      // and no test asked the counter that knew.
      expect(dropped, `the router chose a code the vocabulary cannot sign: ${JSON.stringify(dropped)}`).toEqual([])
    })
  }

  it('a lane probe (no task id) writes no file at all — the tick asks routing many times a tick', () => {
    const { dropped } = routeThroughTheLedger({ lane: 'prod' })
    expect(existsSync(journalPath('undefined'))).toBe(false)
    expect(dropped).toEqual([])
  })
})

describe('the two intentions §5 of the fleet document records stay recorded', () => {
  const doc = readFileSync(join(HERE, '..', '..', 'docs', 'FLEET-INVARIANTS.md'), 'utf8').replace(/\r\n/g, '\n')

  it('reads the document at all — an assertion over an empty string passes forever', () => {
    expect(doc.length).toBeGreaterThan(1000)
    expect(doc).toContain('## 5. Non-goals')
  })

  it('§5.9 still says no governance is built for roles that start work without a person', () => {
    expect(doc).toContain('### 5.9')
    expect(doc).toContain('a rule with nothing to govern')
    expect(doc).toContain('deliberately not built')
  })

  it('§5.10 still says fan-out measurement and post-hoc scoring are not built, and why', () => {
    expect(doc).toContain('### 5.10')
    expect(doc).toContain('Routing picks exactly one worker')
    expect(doc).toContain('Scoring the choice after the fact')
  })
})
