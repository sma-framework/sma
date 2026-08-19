/**
 * worker-stats — the roster's «сделано / не получилось» measured over a PERIOD.
 *
 * WHY THIS FILE EXISTS. The team screen used to count a worker's finished and failed work by
 * walking `data.done` — the rows the state read happened to still be carrying. That list is
 * capped and it is about «сделано за ночь», so the two numbers under a worker's name answered
 * a question nobody asked: not «how much did this one do» but «how much of what is still on
 * screen belongs to this one». The counts moved when the list moved, and a worker whose work
 * had scrolled off read as a worker who had done nothing.
 *
 * The material for the honest answer was already being written: the per-attempt ledger, one
 * immutable row per try, with the moment the try ended on it. So the count is taken THERE,
 * over an explicit window of days, and the screen only renders it.
 *
 * WHAT THIS FILE PINS, and each of these is a way the number could go back to being a guess:
 *   - the arithmetic, on a fixture whose answer is known before the run: two done, one failed,
 *     and the attempt that ended 31 days ago is OUTSIDE the window and does not count;
 *   - an attempt with no end mark is not counted — there is nothing to measure, and counting it
 *     as done would be a number nobody wrote down;
 *   - a `reconstructed: true` row is not counted — nobody watched that attempt (reconcile.mjs
 *     appends it from a retry counter after the fact, with outcome «failed»), so putting it in
 *     the failed column would state a failure no one observed;
 *   - two workers are counted apart;
 *   - a ledger that cannot be read yields NO answer (null), never a zero: a zero on this screen
 *     reads as «this worker did nothing», which is a claim, while the truth is «нет данных»;
 *   - THE WIRE: the number the payload carries comes from the LEDGER OVER THE PERIOD, not from
 *     the tail of the same read. The fixture deliberately makes the two disagree — seven done
 *     rows in the tail against two in the ledger — so a screen that went back to counting the
 *     tail fails here;
 *   - the read is cached: the state read is frequent, and scanning the whole ledger directory
 *     on every poll is the derive attacking its own daemon.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync, readdirSync as fsReaddirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recordAttempt } from '../src/queue/attempt-ledger.mjs'
import { createWorkerStats } from '../src/front/worker-stats.mjs'
import { deriveState } from '../src/front/state.mjs'

const DAY = 86_400_000
const NOW = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const dirs: string[] = []
function ledgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-worker-stats-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** The fixture of the known answer: w1 has two done and one failed INSIDE the 30-day window. */
function seedKnownAnswer(dir: string) {
  recordAttempt(dir, { taskId: 'T-A', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - DAY) })
  recordAttempt(dir, { taskId: 'T-B', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - DAY) })
  recordAttempt(dir, { taskId: 'T-C', attempt: 1, workerId: 'w1', outcome: 'failed', endedAt: iso(NOW - 29 * DAY) })
  // outside the window — the border is asserted, not assumed
  recordAttempt(dir, { taskId: 'T-D', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - 31 * DAY) })
}

describe('createWorkerStats — the count over a period, out of the attempt ledger', () => {
  it('counts done and failed inside the window, and leaves the 31-day-old attempt out', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    const stats = createWorkerStats({ ledgerDir: dir, clock: () => NOW })
    expect(stats.statsFor('w1')).toEqual({ done: 2, failed: 1 })
  })

  it('an attempt with no end mark, and a reconstructed row, are not counted', () => {
    const dir = ledgerDir()
    // no endedAt: the try may still be running — there is nothing to measure
    recordAttempt(dir, { taskId: 'T-E', attempt: 1, workerId: 'w1', outcome: 'completed' })
    // nobody watched this one: reconcile writes it from a retry counter, with outcome «failed»
    recordAttempt(dir, {
      taskId: 'T-F',
      attempt: 1,
      workerId: 'w1',
      outcome: 'failed',
      reconstructed: true,
      endedAt: iso(NOW - DAY),
    })
    const stats = createWorkerStats({ ledgerDir: dir, clock: () => NOW })
    expect(stats.statsFor('w1')).toEqual({ done: 0, failed: 0 })
  })

  it('two workers are counted apart', () => {
    const dir = ledgerDir()
    recordAttempt(dir, { taskId: 'T-G', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - DAY) })
    recordAttempt(dir, { taskId: 'T-H', attempt: 1, workerId: 'w2', outcome: 'failed', endedAt: iso(NOW - DAY) })
    recordAttempt(dir, { taskId: 'T-I', attempt: 1, workerId: 'w2', outcome: 'completed', endedAt: iso(NOW - 2 * DAY) })
    const stats = createWorkerStats({ ledgerDir: dir, clock: () => NOW })
    expect(stats.statsFor('w1')).toEqual({ done: 1, failed: 0 })
    expect(stats.statsFor('w2')).toEqual({ done: 1, failed: 1 })
  })

  it('a ledger that cannot be read says «нет данных» (null), never zero', () => {
    const stats = createWorkerStats({ ledgerDir: join(tmpdir(), 'sma-no-such-ledger-dir-17-4'), clock: () => NOW })
    expect(stats.statsFor('w1')).toBe(null)
    expect(stats.all()).toBe(null)
    // …and a daemon wired with no ledger dir at all is the same absence, not an exception
    expect(createWorkerStats({ clock: () => NOW }).statsFor('w1')).toBe(null)
  })

  it('a corrupt row never throws — the rest of the ledger is still counted', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    appendFileSync(join(dir, 'T-A.jsonl'), '{ this is not json\n')
    const stats = createWorkerStats({ ledgerDir: dir, clock: () => NOW })
    expect(stats.statsFor('w1')).toEqual({ done: 2, failed: 1 })
  })

  it('the directory is read once per TTL, and again once the clock has moved past it', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    let reads = 0
    const fsImpl = {
      readdirSync: (p: string) => {
        reads += 1
        return fsReaddirSync(p)
      },
    }
    let now = NOW
    const stats = createWorkerStats({ ledgerDir: dir, fsImpl, clock: () => now, ttlMs: 60_000 })
    expect(stats.statsFor('w1')).toEqual({ done: 2, failed: 1 })
    expect(stats.statsFor('w1')).toEqual({ done: 2, failed: 1 })
    expect(reads).toBe(1)
    now = NOW + 61_000
    expect(stats.statsFor('w1')).toEqual({ done: 2, failed: 0 }) // T-C is now 29d+ … still inside
    expect(reads).toBe(2)
  })

  it('the window length is the caller’s, not a constant baked into the count', () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)
    const wide = createWorkerStats({ ledgerDir: dir, clock: () => NOW, windowDays: 40 })
    expect(wide.statsFor('w1')).toEqual({ done: 3, failed: 1 })
  })
})

describe('THE WIRE — the roster row carries the ledger’s count, not the tail of its own read', () => {
  it('workers[].stats30d contradicts the done[] tail and matches the ledger', async () => {
    const dir = ledgerDir()
    seedKnownAnswer(dir)

    // The tail deliberately disagrees: SEVEN finished rows for the same worker. A screen (or a
    // derive) that counted these would print 7/0 — the number this whole plan exists to remove.
    const rows = Array.from({ length: 7 }, (_, i) => ({
      id: `TAIL-${i}`,
      status: 'completed',
      lane: 'prod',
      title: `t${i}`,
      workerId: 'w1',
      completedAt: NOW - 1000,
    }))

    const payload: any = await deriveState({
      adapter: { list: async () => rows.slice() },
      ledgerDir: dir,
      workerStats: createWorkerStats({ ledgerDir: dir, clock: () => NOW }),
      windows: () => ({ fiveHour: { status: 'unknown' }, week: { status: 'unknown' } }),
      config: { workers: [{ id: 'w1', lane: 'prod', account: { name: 'a1' } }] },
      clock: () => NOW,
    })

    expect(payload.done.length).toBe(7) // the tail is really there, and really disagrees
    expect(payload.workers[0].stats30d).toEqual({ done: 2, failed: 1 })
  })

  it('a daemon with no worker-stats collaborator carries NO stats30d — absence, not zeros', async () => {
    const payload: any = await deriveState({
      adapter: { list: async () => [] },
      windows: () => ({ fiveHour: { status: 'unknown' }, week: { status: 'unknown' } }),
      config: { workers: [{ id: 'w1', lane: 'prod', account: { name: 'a1' } }] },
      clock: () => NOW,
    })
    expect(payload.workers[0].stats30d).toBeUndefined()
  })
})
