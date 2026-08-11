/**
 * Tests for the cost history the «Расходы» screen draws.
 *
 * `usageSeries` fills a seam the state derive declared from its first line and nothing had
 * filled: without it the cost view is permanently empty, whatever the park actually spent.
 * The load-bearing invariants:
 *   - one point per day, per account, per LANE — so the payload stays small no matter how
 *     many tasks a day held,
 *   - the conversation is its own lane: rows booked under the reserved `chat-` prefix never
 *     land in the ordinary point of the same day and account, and the conversation's point
 *     carries a real booking id so the screen can find it by that same prefix,
 *   - TOKENS travel beside the euros: a subscription row books no dollar cost, and a series
 *     that carried money alone would show a night of real work as a flat zero,
 *   - the window is a rolling number of days, and the account list narrows it,
 *   - a missing or corrupt book yields fewer points, never an error.
 *
 * The book is injected as a string, so the suite never touches a real ledger.
 */

import { describe, it, expect } from 'vitest'

import { CHAT_TASK_ID_PREFIX, usageSeries } from '../src/runner/usage.mjs'

const NOW = Date.parse('2026-08-01T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

/** The local calendar day of a moment, the way the series names it. */
function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function book(rows: object[]) {
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  return { readFileSync: () => text }
}

function row(over: Record<string, unknown> = {}) {
  return {
    ts: new Date(NOW).toISOString(),
    accountName: 'клод-основной',
    provider: 'claude',
    taskId: 'task-1',
    model: 'sonnet',
    inputTokens: 100,
    outputTokens: 50,
    source: 'stream-result',
    ...over,
  }
}

const call = (fsImpl: object, over: Record<string, unknown> = {}) =>
  usageSeries({ dataDir: '/data', clock: () => NOW, fsImpl, ...over })

describe('usageSeries — one point per day, per account, per lane', () => {
  it('sums the rows of one account-day into a single point', () => {
    const series = call(book([row(), row({ taskId: 'task-2', inputTokens: 20, outputTokens: 5 })]))
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({ account: 'клод-основной', day: dayOf(NOW), tokensIn: 120, tokensOut: 55 })
  })

  it('keeps different days and different accounts apart', () => {
    const series = call(
      book([
        row(),
        row({ ts: new Date(NOW - 2 * DAY).toISOString() }),
        row({ accountName: 'кодекс' }),
      ]),
    )
    expect(series).toHaveLength(3)
    expect(new Set(series.map((p: any) => p.day)).size).toBe(2)
    expect(new Set(series.map((p: any) => p.account)).size).toBe(2)
  })

  it('carries the token counts a subscription row books, with euros honestly zero', () => {
    const series = call(book([row()])) // no costUsd — a subscription session
    expect(series[0].eur).toBe(0)
    expect(series[0].tokensIn + series[0].tokensOut).toBeGreaterThan(0)
  })

  it('sums the api-fallback money when the rows carry it, rounded to cents', () => {
    const series = call(
      book([row({ costUsd: 0.014, channel: 'api' }), row({ taskId: 'task-2', costUsd: 0.019, channel: 'api' })]),
    )
    expect(series[0].eur).toBe(0.03)
  })

  it('keeps a subscription estimate OUT of the euro column — the plan absorbed it (QA D4)', () => {
    // One chat message on a subscription window used to render as «платный канал сегодня
    // 0,12 €» directly above the line saying the paid channel is silent.
    const series = call(book([row({ costUsd: 0.12 }), row({ taskId: 'task-2', costUsd: 0.05, channel: 'api' })]))
    expect(series[0].eur).toBe(0.05)
    expect(series[0].tokensIn).toBeGreaterThan(0) // the work itself still shows, in tokens
  })
})

describe('usageSeries — the conversation is its own lane (the «Разговор» line)', () => {
  it('never mixes a conversation turn into the ordinary point of the same account-day', () => {
    const series = call(book([row(), row({ taskId: `${CHAT_TASK_ID_PREFIX}1754000000000`, inputTokens: 7, outputTokens: 3 })]))
    expect(series).toHaveLength(2)
    const chat = series.find((p: any) => String(p.taskId ?? '').startsWith(CHAT_TASK_ID_PREFIX))
    const tasks = series.find((p: any) => p.taskId === undefined)
    expect(chat).toMatchObject({ tokensIn: 7, tokensOut: 3 })
    expect(tasks).toMatchObject({ tokensIn: 100, tokensOut: 50 })
  })

  it('identifies the conversation point with a REAL booking id, and leaves task points anonymous', () => {
    const series = call(
      book([
        row({ taskId: `${CHAT_TASK_ID_PREFIX}1`, inputTokens: 1, outputTokens: 1 }),
        row({ taskId: `${CHAT_TASK_ID_PREFIX}2`, inputTokens: 1, outputTokens: 1 }),
        row(),
      ]),
    )
    const chat = series.find((p: any) => p.taskId !== undefined)
    expect(chat.taskId).toBe(`${CHAT_TASK_ID_PREFIX}2`)
    expect(chat.tokensIn).toBe(2) // the point is the day's total, not one turn
    expect(series.find((p: any) => p.taskId === undefined).taskId).toBeUndefined()
  })

  it('shows no conversation point at all when nothing was said', () => {
    const series = call(book([row(), row({ taskId: 'task-2' })]))
    expect(series.every((p: any) => p.taskId === undefined)).toBe(true)
  })
})

describe('usageSeries — the window, the account filter and the fail-open posture', () => {
  it('drops rows older than the asked-for number of days', () => {
    const series = call(book([row(), row({ ts: new Date(NOW - 20 * DAY).toISOString() })]), { days: 14 })
    expect(series).toHaveLength(1)
  })

  it('narrows to the asked-for accounts', () => {
    const series = call(book([row(), row({ accountName: 'кодекс' })]), { accounts: ['кодекс'] })
    expect(series).toHaveLength(1)
    expect(series[0].account).toBe('кодекс')
  })

  it('is empty — never a throw — when the book is missing', () => {
    const series = usageSeries({
      dataDir: '/data',
      clock: () => NOW,
      fsImpl: {
        readFileSync: () => {
          throw new Error('ENOENT')
        },
      },
    })
    expect(series).toEqual([])
  })

  it('skips a corrupt row and keeps the rest', () => {
    const fsImpl = { readFileSync: () => `${JSON.stringify(row())}\n{not json\n` }
    expect(call(fsImpl)).toHaveLength(1)
  })

  it('skips a row whose moment cannot be read at all', () => {
    expect(call(book([row({ ts: 'вчера' })]))).toEqual([])
  })
})
