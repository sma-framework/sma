/**
 * ЧЕТЫРЕ ЧИСЛА И ЦЕНА «КАК ЕСЛИ БЫ ПО API» — ПРОВОД ОТ КАДРА ПОТОКА ДО ДВЕРИ СОСТОЯНИЯ.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ. Не арифметику — она проверяется там, где живёт (ценник в
 * scripts/sma/__tests__/pricing.test.ts, сложение точек в usage-series.test.ts). Он
 * доказывает, что числа, сказанные финальным кадром, ДОЕХАЛИ до того ответа, который читает
 * окно: GET /api/state. Ровно этот класс дефекта и был предметом задачи — читатель кадра
 * возвращал все четыре числа с самого начала, строка книги брала два, а точка расходов
 * складывала их в одну колонку «Токены», и ни один зелёный тест этого не видел, потому что
 * каждая половина по отдельности была права.
 *
 * ПОЭТОМУ ЗДЕСЬ НИЧЕГО НЕ ПОДДЕЛАНО МЕЖДУ КАДРОМ И ДВЕРЬЮ: настоящий разбор кадра, настоящий
 * сборщик строки, настоящий писатель книги, настоящий читатель книги, настоящий деривер
 * состояния и настоящий сервер. Подделан только диск — книга живёт в строке в памяти, потому
 * что предмет проверки не файловая система.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { parseClaudeEvent } from '../src/runner/stream.mjs'
import { claudeUsageFromResult, bookUsage, usageSeries } from '../src/runner/usage.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'

const TOKEN = 'c'.repeat(64)
const NOW = Date.parse('2026-08-28T10:00:00Z')
const ACCOUNT = 'клод-основной'

/** ЧИСЛА, КОТОРЫЕ ИЩЕМ НА ВЫХОДЕ ДВЕРИ. Четыре разных — перепутанные поля не совпадут. */
const IN = 1_000_000
const OUT = 200_000
const CACHE_READ = 2_000_000
const CACHE_WRITE = 400_000

/** opus по общему ценнику: 5,00 + 5,00 + 1,00 + 2,50 = 13,50 за эти четыре числа. */
const EXPECTED_USD = 13.5

const frame = (over: object = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
    total_cost_usd: 0.42,
    modelUsage: {
      'claude-opus-5': {
        inputTokens: IN,
        outputTokens: OUT,
        cacheReadInputTokens: CACHE_READ,
        cacheCreationInputTokens: CACHE_WRITE,
      },
    },
    ...over,
  })

/** Тот же кадр в snake_case — так его писала часть сборок вендорской командной строки. */
const SNAKE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.42,
  session_id: '3f2b1a0c-0000-4000-8000-abcdefabcdef',
  model_usage: {
    'claude-opus-5': {
      input_tokens: IN,
      output_tokens: OUT,
      cache_read_input_tokens: CACHE_READ,
      cache_creation_input_tokens: CACHE_WRITE,
    },
  },
})

/** Книга — одна строка в памяти: кадр → строка → книга → чтение книги. */
function bookOf(lines: string[]) {
  const written: string[] = []
  for (const line of lines) {
    const event = parseClaudeEvent(line)
    bookUsage({
      dataDir: '/data',
      event: claudeUsageFromResult(event, { accountName: ACCOUNT, taskId: 'R-1', attempt: 1 }),
      clock: () => NOW,
      fsImpl: { mkdirSync: () => {}, appendFileSync: (_p: string, text: string) => written.push(text) },
    })
  }
  return { readFileSync: () => written.join('') }
}

// ── дверь состояния, поднятая целиком ──────────────────────────────────────────────────────

function mkReq(url: string) {
  const req: any = Readable.from([])
  req.method = 'GET'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}` }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    body: '',
    writeHead(code: number) {
      res.statusCode = code
      return res
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      return res
    },
  }
  return res
}

/** GET /api/state настоящим сервером над настоящим деривером и настоящим чтением книги. */
async function stateOver(fsImpl: object) {
  const front = createFrontServer({
    config: {
      token: TOKEN,
      workers: [{ id: 'max-1', lane: 'prod', account: { name: ACCOUNT } }],
      budget: { monthlyApiCapUsd: 40 },
    },
    deps: {
      deriveState,
      adapter: { list: async () => [] },
      windows: () => ({ pct5h: 0, pctWeek: 0, estimated: true }),
      usageSeries: (args: object) => usageSeries({ dataDir: '/data', fsImpl, ...args }),
      clock: () => NOW,
    },
  })
  const res = mkRes()
  await front.handle(mkReq('/api/state'), res)
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body)
}

describe('кадр → книга → дверь состояния: четыре числа и модель доезжают до окна', () => {
  it('все четыре числа лежат в точке расходов, каждое на своём месте', async () => {
    const state = await stateOver(bookOf([frame()]))

    expect(state.costs.series).toHaveLength(1)
    expect(state.costs.series[0]).toMatchObject({
      account: ACCOUNT,
      tokensIn: IN,
      tokensOut: OUT,
      cacheRead: CACHE_READ,
      cacheWrite: CACHE_WRITE,
    })
  })

  it('точка называет модель — без неё цену не по чему считать и день не объяснить', async () => {
    const state = await stateOver(bookOf([frame()]))
    expect(state.costs.series[0].model).toBe('claude-opus-5')
  })

  it('цена «как если бы по API» посчитана по общему ценнику и приехала отдельным полем', async () => {
    const state = await stateOver(bookOf([frame()]))
    const point = state.costs.series[0]

    expect(point.apiEquivalentUsd).toBe(EXPECTED_USD)
    // И НЕ СЛОЖЕНА С НАСТОЯЩИМИ ДЕНЬГАМИ: работа шла по подписке, счёта за неё не было.
    expect(point.usd).toBe(0)
    expect(point.unpricedTokens).toBe(0)
  })

  it('snake_case тех же полей доезжает так же — иначе дверь молча отдаёт нули', async () => {
    const state = await stateOver(bookOf([SNAKE]))
    expect(state.costs.series[0]).toMatchObject({
      tokensIn: IN,
      tokensOut: OUT,
      cacheRead: CACHE_READ,
      cacheWrite: CACHE_WRITE,
      apiEquivalentUsd: EXPECTED_USD,
    })
  })

  it('две попытки за день складываются в одну точку — и по числам, и по цене', async () => {
    const state = await stateOver(bookOf([frame(), frame()]))
    expect(state.costs.series).toHaveLength(1)
    expect(state.costs.series[0]).toMatchObject({
      tokensIn: IN * 2,
      cacheRead: CACHE_READ * 2,
      apiEquivalentUsd: EXPECTED_USD * 2,
    })
  })
})
