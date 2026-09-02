/**
 * ЗАКРЫТЬ СЛОВАМИ — ВЕСЬ ПРОВОД, ОТ ПАЛЬЦА ДО СТОЛБИКА «ГОТОВО».
 *
 * ═══════════════ ЧТО БЫЛО ЗАМЕРЕНО ═══════════════
 *
 * У строки, стоящей на человеке, было ровно ОДНО действие — «вернуть в очередь», то есть
 * заплатить за ещё один заход. 02.09.2026 в столбике ожидания стояли четыре такие строки с
 * 30.08: ни одна не могла быть исполнена без чужой починки, и вернуть их значило сжечь деньги
 * об ту же стену. Снять их из окна было НЕЧЕМ: дверь отмены берёт только ЖИВУЮ работу и
 * честно отвечала «нечего останавливать», дверь слов по законченной работе отказывает 409, а
 * дверь возврата на двух из четырёх отвечала «race lost» — её CAS ищет приёмочную строку, а
 * строке, вставшей у потолка ходов, приёмочной строки не заводили вовсе.
 *
 * ═══════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════
 *
 *   1. ДВЕРЬ ПРИНИМАЕТ СЛОВО и пишет его тем же seam-ом, каким читает список; живую работу
 *      она не закрывает, неизвестную задачу не выдумывает, а «сделано иначе» без sha или
 *      причины отвергает ДО записи.
 *   2. СПИСКИ ДВЕРИ И ОКНА — ОДИН СПИСОК. Кнопка, слова которой дверь не знает, — это 400 в
 *      лицо человеку; исход, о котором знает дверь и не знает окно, — выход, которым нельзя
 *      воспользоваться.
 *   3. ОКНО ПРЕДЛАГАЕТ ДЕЙСТВИЕ РОВНО ТАМ, ГДЕ ДВЕРЬ ЕГО ПРИМЕТ — сверено по каждому
 *      состоянию словаря очереди, а не на одном примере.
 *   4. ЗАКРЫТАЯ СЛОВАМИ СТРОКА УХОДИТ ИЗ «ЖДУТ ВАС» В «ГОТОВО» СО СВОИМ СЛОВОМ, а не
 *      исчезает и не молчит: путь строка очереди → дверь состояния → единица доски пройден
 *      целиком, обоими концами (сделанная работа и сорвавшаяся).
 *   5. ВСТАВШЕМУ КУСКУ СБОРКИ ЕСТЬ ЧТО СКАЗАТЬ: «повторить» несёт записку человека до
 *      следующей выдачи этого куска, а пропуск и отмена её не принимают — им некому передать.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: как слово ложится в базу и читается обратно из неё (это `pgboss-backend.test.ts`,
 * где живёт модель очереди с её приёмочной таблицей).
 */

import { Readable } from 'node:stream'

import { describe, it, expect } from 'vitest'

import { createFrontServer } from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'
import { CLOSING_REASONS, CLOSING_REASON_LABELS, TASK_STATUSES, closingReasonKnown } from '../src/queue/adapter.mjs'
import { CLOSING_OPTIONS, canCloseWithWords, closingNeedsWords } from '../../spa/src/screens/task-card/close'
import { buildUnits, columnOf } from '../../spa/src/screens/tasks/units'

const TOKEN = 'a'.repeat(64)
const NOW = 1_000_000_000_000

// ── fake req/res (та же форма, что в front-auth.test.ts) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkReq(body: any, url = '/api/task/close') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = 'POST'
  req.url = url
  req.headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    headersSent: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    setHeader(k: string, v: unknown) {
      res.headers[k.toLowerCase()] = v
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()]
    },
    write(c: unknown) {
      res.body += String(c)
      return true
    },
    end(c?: unknown) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

/**
 * Дверь с записывающими зависимостями: `casExec` ловит оператор и его значения, `list`
 * рассказывает, что эта строка сейчас делает. Приёмочная строка отвечает «записал», пока
 * тест не попросит обратного.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkFront(over: any = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seen: any = { sql: null, params: null, enqueued: null }
  const rows = over.rows ?? [{ id: 'R-1', status: 'awaiting_approval', title: 'работа', attempt: 1, lane: 'prod' }]
  const deps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    casExec: async (sql: string, params: any[]) => {
      seen.sql = sql
      seen.params = params
      return { rows: over.wrote === false ? [] : [{ id: 'R-1' }] }
    },
    taskTable: 'sma_task_attempts',
    adapter: {
      list: async () => {
        if (over.listThrows) throw new Error('database is away')
        return rows.slice()
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      enqueue: async (task: any) => {
        seen.enqueued = task
        return { ok: true }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveBatch: async () => true,
    },
    clock: () => NOW,
    ...(over.deps ?? {}),
  }
  return { front: createFrontServer({ config: { token: TOKEN }, deps }), seen }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(front: any, body: any, url = '/api/task/close') {
  const res = mkRes()
  await front.handle(mkReq(body, url), res)
  return res
}

describe('дверь «закрыть словами»: что она принимает и что отвергает', () => {
  it('пишет слово человека и отвечает тем, что записала', async () => {
    const { front, seen } = mkFront()
    const res = await post(front, { taskId: 'R-1', reason: 'obsolete', note: 'предмет изменился' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, taskId: 'R-1', reason: 'obsolete', note: 'предмет изменился' })
    // ПРОВОД, А НЕ ВЕЖЛИВЫЙ ОТВЕТ: оператор ушёл в ту же приёмочную таблицу, и слово человека
    // доехало до него значениями, а не склейкой в текст запроса.
    expect(String(seen.sql)).toContain('sma_task_attempts')
    expect(String(seen.sql)).toContain('ON CONFLICT')
    expect(seen.params).toEqual(['R-1', 'closed', 'obsolete', 'предмет изменился', 'approving'])
  })

  it('слово вне закрытого словаря — 400 ДО всякой записи', async () => {
    const { front, seen } = mkFront()
    const res = await post(front, { taskId: 'R-1', reason: 'надоело' })
    expect(res.statusCode).toBe(400)
    expect(seen.sql).toBeNull()
  })

  it('«сделано иначе» без sha или причины не принимается — такое утверждение нечем перепроверить', async () => {
    const { front, seen } = mkFront()
    const res = await post(front, { taskId: 'R-1', reason: 'done_otherwise', note: '   ' })
    expect(res.statusCode).toBe(400)
    expect(seen.sql).toBeNull()

    const ok = await post(mkFront().front, { taskId: 'R-1', reason: 'done_otherwise', note: 'abc1234' })
    expect(ok.statusCode).toBe(200)
  })

  it('живую работу не закрывает: сначала остановите, потом закрывайте', async () => {
    for (const status of ['queued', 'claimed']) {
      const { front, seen } = mkFront({ rows: [{ id: 'R-1', status, attempt: 1 }] })
      const res = await post(front, { taskId: 'R-1', reason: 'obsolete' })
      expect(res.statusCode, status).toBe(409)
      expect(seen.sql, status).toBeNull()
    }
  })

  it('о задаче, которой в очереди нет, слова не говорят', async () => {
    const { front, seen } = mkFront({ rows: [] })
    const res = await post(front, { taskId: 'R-1', reason: 'obsolete' })
    expect(res.statusCode).toBe(404)
    expect(seen.sql).toBeNull()
  })

  it('нечитаемая очередь — это отказ, а не закрытие вслепую', async () => {
    const { front, seen } = mkFront({ listThrows: true })
    const res = await post(front, { taskId: 'R-1', reason: 'obsolete' })
    expect(res.statusCode).toBe(503)
    expect(seen.sql).toBeNull()
  })

  it('строка, о которой слово уже сказано, отвечает отказом, а не вторым закрытием', async () => {
    const { front } = mkFront({ wrote: false })
    const res = await post(front, { taskId: 'R-1', reason: 'obsolete' })
    expect(res.statusCode).toBe(409)
  })

  it('поле, которого дверь не называла, — 400 (explicit-pick)', async () => {
    const { front } = mkFront()
    const res = await post(front, { taskId: 'R-1', reason: 'obsolete', command: 'rm -rf /' })
    expect(res.statusCode).toBe(400)
  })

  it('демон без приёмочной таблицы честно отвечает «пока нельзя», а не 500', async () => {
    const { front } = mkFront({ deps: { casExec: undefined } })
    const res = await post(front, { taskId: 'R-1', reason: 'obsolete' })
    expect(res.statusCode).toBe(501)
  })
})

describe('списки двери и окна — один список', () => {
  it('исходы окна и исходы двери совпадают по словам', () => {
    expect(CLOSING_OPTIONS.map((o) => o.id)).toEqual([...CLOSING_REASONS])
    for (const o of CLOSING_OPTIONS) {
      expect(closingReasonKnown(o.id), o.id).toBe(true)
      // Подпись кнопки — та же подпись, что дверь ставит на закрытую карточку, только с
      // заглавной: два разных перевода одного слова однажды разъехались бы молча.
      expect(o.label.toLowerCase(), o.id).toBe(CLOSING_REASON_LABELS[o.id])
      expect(o.detail.length, o.id).toBeGreaterThan(0)
    }
  })

  it('слов требует ровно тот исход, без которого дверь отказывает', async () => {
    for (const o of CLOSING_OPTIONS) {
      const { front } = mkFront()
      const res = await post(front, { taskId: 'R-1', reason: o.id })
      expect(closingNeedsWords(o.id), o.id).toBe(res.statusCode === 400)
    }
  })

  it('окно предлагает действие ровно там, где дверь его примет — по всему словарю состояний', async () => {
    for (const status of TASK_STATUSES) {
      const { front } = mkFront({ rows: [{ id: 'R-1', status, attempt: 1 }] })
      const res = await post(front, { taskId: 'R-1', reason: 'obsolete' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(canCloseWithWords(status as any), status).toBe(res.statusCode === 200)
    }
  })
})

describe('закрытая словами строка: из «ЖДУТ ВАС» в «Готово», со своим словом', () => {
  const config = { agingHours: 24, workers: [] }
  const win = (state: string) => ({ state, usedPct: null, resetAt: null })
  const windows = () => ({ fiveHour: win('open'), week: win('open') })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const derive = async (rows: any[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await deriveState({
      adapter: { list: async () => rows.slice() },
      ledger: () => [],
      windows,
      config,
      clock: () => NOW,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const board = (payload: any) =>
    buildUnits({
      queue: payload.queue,
      awaiting: payload.awaiting,
      workers: [],
      done: payload.done,
      batches: payload.batches ?? [],
      phases: [],
      activeProject: null,
      machine: '',
      selfMachine: 'self',
      now: NOW,
    })

  const closedRow = (over = {}) => ({
    id: 'R-1',
    status: 'failed',
    lane: 'prod',
    title: 'ступень, чей предмет устарел',
    attempt: 1,
    completedAt: NOW,
    failure_reason: 'manual',
    closedByPerson: { reason: 'obsolete', note: 'ветка сведена руками' },
    ...over,
  })

  it('дверь состояния несёт слово человека рядом с причиной, а не вместо неё', async () => {
    const payload = await derive([closedRow()])
    expect(payload.awaiting).toHaveLength(0)
    expect(payload.done[0].closed).toEqual({
      reason: 'obsolete',
      reasonLabel: 'устарело',
      note: 'ветка сведена руками',
    })
  })

  it('сорвавшаяся строка, закрытая словами, стоит в «Готово» и говорит, чем закрыта', async () => {
    const payload = await derive([closedRow()])
    const [unit] = board(payload)

    expect(columnOf(unit)).toBe('done')
    expect(unit.wait).toBeUndefined()
    expect(unit.next).toContain('устарело')
    expect(unit.next).toContain('ветка сведена руками')
  })

  it('та же строка БЕЗ слова человека остаётся в «ЖДУТ ВАС» — столбик пустеет от решения, а не от правки', async () => {
    const payload = await derive([{ ...closedRow(), failure_reason: 'turns_exhausted', closedByPerson: undefined }])
    const [unit] = board(payload)

    expect(columnOf(unit)).toBe('you')
    expect(unit.wait).toBeDefined()
  })

  it('сделанная работа, закрытая словами, тоже несёт своё слово — «сделано иначе» законно и на зелёной строке', async () => {
    const payload = await derive([
      { ...closedRow(), status: 'completed', failure_reason: null, closedByPerson: { reason: 'done_otherwise', note: 'сделано в abc1234' } },
    ])
    const [unit] = board(payload)

    expect(columnOf(unit)).toBe('done')
    expect(unit.next).toContain('сделано иначе')
    expect(unit.next).toContain('abc1234')
  })
})

describe('вставшему куску сборки есть что сказать', () => {
  const parent = {
    id: 'B-1',
    status: 'queued',
    lane: 'prod',
    title: 'сборка',
    attempt: 1,
    data: { batch: 'parent' },
    batchId: 'B-1',
  }
  const broken = {
    id: 'R-9',
    status: 'failed',
    lane: 'prod',
    title: 'кусок, упавший о потолок',
    attempt: 1,
    batchId: 'B-1',
    failure_reason: 'turns_exhausted',
  }

  it('«повторить» несёт записку человека до следующей выдачи этого куска', async () => {
    const { front, seen } = mkFront({ rows: [parent, broken] })
    const res = await post(
      front,
      { batchId: 'B-1', decision: 'retry', itemId: 'R-9', note: 'только досдай по ритуалу' },
      '/api/batch/decide',
    )

    expect(res.statusCode).toBe(200)
    expect(seen.enqueued.id).toBe('R-9')
    expect(seen.enqueued.note).toBe('только досдай по ритуалу')
    expect(seen.enqueued.attempt).toBe(2)
  })

  it('без записки повтор остаётся прежним: пустого слова на карточке не появляется', async () => {
    const { front, seen } = mkFront({ rows: [parent, broken] })
    await post(front, { batchId: 'B-1', decision: 'retry', itemId: 'R-9' }, '/api/batch/decide')
    expect(seen.enqueued.note).toBeUndefined()
  })

  it('пропуск и отмена записки не принимают — им некому её передать', async () => {
    for (const decision of ['skip', 'cancel']) {
      const { front } = mkFront({ rows: [parent, broken] })
      const res = await post(front, { batchId: 'B-1', decision, itemId: 'R-9', note: 'слово' }, '/api/batch/decide')
      expect(res.statusCode, decision).toBe(400)
    }
  })
})
