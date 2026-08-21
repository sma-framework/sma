/**
 * THE MONEY VERDICT, ALL THE WAY TO THE ROW SOMEBODY READS.
 *
 * The rule that decides whether the paid channel may be used is written, tested and correct.
 * That proves nothing about the machine: between «the rule said stop» and «a person can see
 * why his task did not run» there are two joints, and both are cut today.
 *
 *   the money rule → the router                → the task's decision journal   (joint one)
 *   the money rule → the tick                  → the attempt row               (joint two)
 *
 * Joint one is cut by a vocabulary: the router hands the verdict's word straight to the
 * journal sink, the sink drops every word the closed vocabulary does not carry, and neither
 * of the two words the money rule can answer with is in it. The decision is made, acted on,
 * and never recorded — so the card says the route was never decided.
 *
 * Joint two is cut by a hardcoded string: the tick meets a route with no target, and writes
 * the same «no window left» on the attempt no matter what actually stopped it. A person
 * reading that row is told to wait for a window that will never help him, when the truth is
 * that a spending ceiling he set himself did the stopping.
 *
 * SO THIS FILE ASSERTS THE WIRE, NOT THE CALCULATION. «budget.mjs returned the stop» is not
 * asserted anywhere here and must not be: that fact was already true while both joints were
 * cut. What is asserted is that the word ARRIVES — at the sink, and at the row.
 *
 * The money rule itself is a seam here, answering a fixed verdict. That is deliberate: the
 * subject is the wire, and a wire test that first has to arrange real spending would be
 * testing the arrangement.
 *
 * THIS FILE IS RED ON ARRIVAL. All three cases state the target behaviour of this work and
 * none of it exists yet; the red run is kept as a receipt, and the work that adds the words
 * and reads the verdict in the tick turns them green.
 */

import { describe, it, expect } from 'vitest'

import { resolveRoute } from '../src/policy/routing.mjs'
import { tick } from '../src/loop.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'

const T0 = 1_700_000_000_000

/** A task that names the paid channel by hand — the branch that always asks the money rule. */
const PAID_TASK = { id: 't-1', attempt: 1, provider: 'api', lane: 'prod' }

/** A money rule that answers one fixed verdict, and records that it was asked. */
function fixedVerdict(verdict: { fallback: boolean; reason: string }) {
  const asked: any[] = []
  const seam = (args: any) => {
    asked.push(args)
    return verdict
  }
  return { seam, asked }
}

describe('the money verdict reaches the decision journal', () => {
  for (const reason of ['budget_stop', 'wait_for_window']) {
    it(`records «${reason}» on the dispatcher layer of the task it stopped`, () => {
      const entries: any[] = []
      const { seam, asked } = fixedVerdict({ fallback: false, reason })

      const route = resolveRoute(PAID_TASK, {
        workers: [],
        windows: () => false,
        clock: () => T0,
        config: {},
        decisionJournal: (entry: any) => entries.push(entry),
        budget: seam,
      })

      // The rule WAS asked and the answer WAS acted on — without this the case below could
      // pass on a router that never consulted anybody.
      expect(asked.length).toBe(1)
      expect(route.useApiFallback).toBe(false)
      expect(route.reasonCode).toBe(reason)

      // …and the same word reached the store. This is the assertion the current tree fails:
      // the sink silently drops a word the closed vocabulary does not carry, so the entry
      // never exists.
      expect(entries.length, 'the stopped decision left no line in the task journal').toBe(1)
      expect(entries[0].taskId).toBe(PAID_TASK.id)
      expect(entries[0].layer).toBe('dispatcher')
      expect(entries[0].payload.code).toBe(reason)
    })
  }
})

describe('the money verdict reaches the attempt row', () => {
  it('stops the worker before it starts and writes the spending stop as the reason', async () => {
    const clock = () => T0
    const adapter = createMemoryQueue({ clock, expireMs: 300000 })
    await adapter.enqueue({
      id: 'BL-1',
      source: 'backlog',
      title: 'work that asked for the paid channel',
      lane: 'prod',
      provider: 'api',
      priority: 0,
      storyPoints: 3,
      acceptance: 'green targeted tests + a reverify receipt',
    })

    const attempts: any[] = []
    const spawned: any[] = []
    const deps: any = {
      adapter,
      ledger: {
        recordAttempt: (a: any) => {
          attempts.push(a)
          return a
        },
        readAttempts: (id: string) => attempts.filter((x) => x.taskId === id),
      },
      config: {
        workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
        agingHours: 24,
        backlogScanMinutes: 60,
        repoDir: '/repo',
        pipeline: { enabled: true },
      },
      routing: { resolveRoute },
      windows: () => true,
      buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
      verbRunner: async () => ({ code: 0, stdout: '{}' }),
      spawnWorker: (spec: any) => {
        spawned.push(spec)
        spec.onExit?.({ code: 0, signal: null })
        return { pid: 4242, kill: () => {} }
      },
      report: async () => {},
      clock,
      journal: () => {},
      budget: () => ({ fallback: false, reason: 'budget_stop' }),
    }

    await tick(deps)

    // STOPPED ON THE DOORSTEP — not «the task did not finish», but no process at all. This is
    // the half that already holds, and it is asserted so the case below cannot be satisfied
    // by a machine that spent the money and then complained about it.
    expect(spawned.length, 'a worker was started despite the spending stop').toBe(0)

    // …AND THE ROW SAYS WHY. The attempt is failed either way today; what it is failed WITH
    // is the defect: a person is sent to wait for a window when a ceiling he set stopped him.
    const row = attempts.find((a) => a.taskId === 'BL-1')
    expect(row, 'the stopped attempt left no row at all').toBeTruthy()
    expect(row.outcome).toBe('failed')
    expect(row.failureReason).toBe('budget_stop')
  })
})
