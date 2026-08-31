/**
 * КНОПКА ОДОБРЕНИЯ — В САМОЙ СТРОКЕ ЛЕНТЫ ДНЯ, А НЕ В ОДНОМ КЛИКЕ ОТ НЕЁ.
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * Работа, проверенная и ждущая слова человека, стояла на «Сегодня» строкой, которая умела
 * ровно одно — открыть боковую панель. Решение жило в панели, то есть в одном клике от того
 * места, где человек его принимает. Утром таких строк несколько, и каждая стоила открытия
 * панели, чтения панели и закрытия панели ради одного слова «да».
 *
 * ═══════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════
 *
 *   1. КНОПКА ЕСТЬ РОВНО У ТОЙ СТРОКИ, КОТОРУЮ ДВЕРЬ ПРИМЕТ. Дверь приёмки переводит строку
 *      из `awaiting_approval` и ниоткуда больше; кнопка над строкой в любом другом состоянии
 *      обещала бы человеку исход, которого он не получит.
 *   2. ПРОВОД ЦЕЛИКОМ: нажатие в ленте доезжает до той же двери, которой пользуется панель, и
 *      строка после него уходит из «Ждут вашего решения» — без единого нового маршрута.
 *   3. ОТКАЗ ГОВОРИТ СЛОВАМИ И ДЕРЖИТ СТРОКУ НА МЕСТЕ. Дверь отвечает 200 и на отказе, поэтому
 *      «нажалась и ничего не сделала» — это состояние, которое лента обязана называть; слова
 *      берутся у двери, а не сочиняются, и стоят на ТОЙ строке, которую нажали.
 *   4. РЕЧЬ ОДНА НА ОБЕИХ ПОВЕРХНОСТЯХ: строка и панель говорят одними словами, иначе человек
 *      учит две привычки для одного действия.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: что делает сама дверь приёмки — слияние, уборка копии, сбор урока (её разбор
 * живёт в `approve-*.test.ts`). Здесь только путь от пальца человека до этой двери.
 */

import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

import { describe, it, expect } from 'vitest'

import { createFrontServer } from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'
import { APPROVABLE_STATUS, approveWord, canApprove, refusalFor } from '../../spa/src/screens/today/approve'
import { approvalRefusal } from '../../spa/src/shell/format'

const NOW = 1_000_000_000_000
const TOKEN = 'test-token-value'

const config = { agingHours: 24, workers: [{ id: 'max-1', lane: 'prod', account: { name: 'max-1' } }] }
const win = (state: string) => ({ state, usedPct: null, resetAt: null })
const windows = () => ({ fiveHour: win('open'), week: win('open') })

/**
 * Очередь в памяти, которую двигает НАСТОЯЩАЯ дверь: `casExec` разбирает те же параметры, что
 * шлёт `casTransition`, и проигранная гонка отвечает нулём строк — как отвечает база.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function memoryQueue(initial: any[]) {
  const rows = initial.map((r) => ({ ...r }))
  return {
    rows,
    list: async () => rows.map((r) => ({ ...r })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exec: async (_sql: string, params: any[]) => {
      const to = params[0]
      const from = params[params.length - 1]
      const id = params[params.length - 2]
      const row = rows.find((r) => r.id === id)
      if (!row || row.status !== from) return { rows: [] }
      row.status = to
      return { rows: [{ id }] }
    },
  }
}

const awaitingRow = (id: string) => ({
  id,
  status: 'awaiting_approval',
  lane: 'prod',
  title: 'сделанная работа, которая ждёт вашего слова',
  attempt: 1,
  workerId: 'max-1',
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const derive = async (rows: any[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await deriveState({
    adapter: { list: async () => rows.map((r) => ({ ...r })) },
    ledger: () => [],
    windows,
    config,
    clock: () => NOW,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkReq(o: any = {}) {
  const { method = 'POST', url = '/', headers = {}, body } = o
  const payload = body == null ? [] : [Buffer.from(JSON.stringify(body))]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(code: number) {
      res.statusCode = code
      res.headersSent = true
      return res
    },
    setHeader() {},
    getHeader() {},
    write(c: unknown) {
      res.body += String(c)
      return true
    },
    end(c?: unknown) {
      if (c != null) res.body += String(c)
      return res
    },
  }
  return res
}

/** Нажатие человека в ленте: та же дверь, тем же телом, что шлёт панель. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function press(front: any, taskId: string) {
  const res = mkRes()
  await front.handle(
    mkReq({
      url: '/api/approve',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: { taskId },
    }),
    res,
  )
  // Отказ гонки дверь пишет словами, а не разбором: тело читается как есть, когда это не JSON.
  let out: Record<string, unknown> = {}
  try {
    out = JSON.parse(res.body || '{}')
  } catch {
    out = { said: res.body }
  }
  return { status: res.statusCode, out }
}

describe('кнопка одобрения появляется у той строки, которую дверь примет', () => {
  it('строка из «Ждут вашего решения» несёт кнопку — и это тот самый статус, из которого ходит дверь', async () => {
    const payload = await derive([awaitingRow('R-1')])
    const row = payload.awaiting[0]

    expect(row.status).toBe(APPROVABLE_STATUS)
    expect(canApprove(row)).toBe(true)
  })

  it('строка, ждущая работника, кнопки не несёт: нажатие на ней дверь бы отказала', async () => {
    const payload = await derive([{ ...awaitingRow('R-2'), status: 'queued' }])

    expect(payload.awaiting).toHaveLength(0)
    expect(canApprove(payload.queue[0])).toBe(false)
  })

  it('ни сорвавшаяся, ни уже принятая работа кнопки не получает — молчание вместо ложного выхода', () => {
    expect(canApprove({ status: 'failed' })).toBe(false)
    expect(canApprove({ status: 'completed' })).toBe(false)
    expect(canApprove({ status: 'approving' })).toBe(false)
    expect(canApprove(null)).toBe(false)
  })
})

describe('провод: нажатие в строке ленты доезжает до двери приёмки', () => {
  it('строка одобряется из ленты и уходит из «Ждут вашего решения» — карточку никто не открывал', async () => {
    const queue = memoryQueue([awaitingRow('R-1')])
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: { list: queue.list },
        casExec: queue.exec,
        verbRunner: async () => ({ merged: true, receipt: { branch: 'wt/R-1' } }),
      },
    })

    const before = await derive(queue.rows)
    expect(canApprove(before.awaiting[0])).toBe(true)

    const { status, out } = await press(front, 'R-1')
    expect(status).toBe(200)
    expect(out.ok).toBe(true)
    expect(approvalRefusal(out)).toBeNull()

    // …и следующее чтение картины уже не ставит эту строку человеку.
    const after = await derive(queue.rows)
    expect(after.awaiting).toHaveLength(0)
  })

  it('второе нажатие по той же строке не одобряет дважды — гонка проиграна, а не тихо повторена', async () => {
    const queue = memoryQueue([awaitingRow('R-1')])
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: { list: queue.list },
        casExec: queue.exec,
        verbRunner: async () => ({ merged: true }),
      },
    })

    expect((await press(front, 'R-1')).out.ok).toBe(true)
    expect((await press(front, 'R-1')).status).toBe(409)
  })
})

describe('отказ двери: строка остаётся на месте и говорит словами', () => {
  it('дверь отвечает 200 с отказом — слова берутся у неё, а строка возвращается в ленту с той же кнопкой', async () => {
    const queue = memoryQueue([awaitingRow('R-1')])
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: { list: queue.list },
        casExec: queue.exec,
        verbRunner: async () => ({ merged: false, message: 'CONFLICT: спорные файлы' }),
      },
    })

    const { status, out } = await press(front, 'R-1')
    expect(status).toBe(200)
    expect(out.ok).toBe(false)

    const said = approvalRefusal(out)
    expect(said).toBe(out.reason)
    expect(said).not.toBe('')

    const after = await derive(queue.rows)
    expect(canApprove(after.awaiting[0])).toBe(true)
  })

  it('слова отказа стоят на нажатой строке, а не над всей лентой', () => {
    const problem = { taskId: 'R-1', text: 'слияние не прошло' }

    expect(refusalFor(problem, 'R-1')).toBe('слияние не прошло')
    expect(refusalFor(problem, 'R-2')).toBeNull()
    expect(refusalFor(null, 'R-1')).toBeNull()
  })
})

describe('одна речь на строке и на панели', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('пока приёмка идёт, обе поверхности говорят одно и то же слово', () => {
    const panel = read('../../spa/src/shell/TaskPanel.tsx')

    expect(approveWord(false)).toBe('Одобрить')
    expect(approveWord(true)).toBe('Принимаю…')
    expect(panel).toContain(approveWord(false))
    expect(panel).toContain(approveWord(true))
  })

  it('лента зовёт дверь не сама: строка называет нажатие, а дверь держит экран', () => {
    const feed = read('../../spa/src/screens/today/DayFeed.tsx')
    const screen = read('../../spa/src/screens/today/index.tsx')

    // Лента остаётся показом — своих запросов у неё нет ни одного.
    expect(feed).not.toContain('useApprove')
    expect(feed).toContain('onApprove')
    expect(screen).toContain('useApprove()')
    expect(screen).toContain('onApprove=')
  })
})
