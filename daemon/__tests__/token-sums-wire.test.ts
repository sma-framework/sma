/**
 * ЧЕТЫРЕ ЧИСЛА ПОСТАВЩИКА — ПРОВОД ОТ КВИТАНЦИИ НА ДИСКЕ ДО ДВЕРЕЙ, КОТОРЫЕ ЧИТАЕТ ОКНО.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ И ЧЕГО НЕ ДОКАЗЫВАЕТ. Соседний сьют (`attempt-tokens-wire`) уже
 * утверждает, что числа финального кадра ДОЕЗЖАЮТ до `receipt.json` попытки. Здесь начинается
 * следующий отрезок того же провода: числа, лежащие на диске, доезжают до ЧЕЛОВЕКА — до
 * карточки задачи, до экрана попытки, до карточки фазы и до строки батча. Ровно этот класс
 * дефекта — «посчитано, записано и никому не отдано» — в этом дереве уже случался, и каждый раз
 * он выглядел совершенно честно: файл на диске полон, а на экране пусто.
 *
 * ПОЭТОМУ КВИТАНЦИИ ЗДЕСЬ НАСТОЯЩИЕ. Ни один читатель не подменён: во временном проекте лежат
 * такие же каталоги прогона, какие оставляет тик, и утверждается ТЕЛО ответа настоящей двери.
 *
 * ЧЕТЫРЕ УТВЕРЖДЕНИЯ, И КАЖДОЕ — ПРО ПРОВОД:
 *
 *   (1) две попытки с известными числами → дверь задачи отдаёт СУММУ, и каждая попытка при
 *       этом несёт свои собственные числа;
 *   (2) попытка старше поля (квитанция без чисел) → её `null`, ноль в сумме и НЕ ошибка:
 *       остальные подходы от этого не перестают быть измеренными;
 *   (3) фаза и батч из ДВУХ задач → сумма двух, каждая со всеми своими подходами;
 *   (4) момент просьбы владельца, записанный дверью батча, доезжает до проекции батча.
 *
 * И ОТДЕЛЬНО — ТАБЛИЦА МАРШРУТОВ НЕ ТРОНУТА: числа приехали полезной нагрузкой существующих
 * ответов, а не новой дверью. Дверь, заведённая ради поля, — это дверь, которую придётся
 * охранять, документировать и когда-нибудь убирать.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { createFrontServer } from '../src/front/server.mjs'
import { deriveState, derivePhaseCard, derivePhaseIndex } from '../src/front/state.mjs'

const TOKEN = 'e'.repeat(64)

// ── временный проект ───────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
function mkProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-sums-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* уборка не роняет сьют */
    }
  }
})

/** ЧИСЛА, КОТОРЫЕ ИЩЕМ НА ЭКРАНЕ. Все разные — совпадение перепутанных полей исключено. */
const FIRST = { input: 100, output: 11, cacheRead: 1000, cacheWrite: 5 }
const SECOND = { input: 200, output: 22, cacheRead: 2000, cacheWrite: 7 }
const BOTH = { input: 300, output: 33, cacheRead: 3000, cacheWrite: 12 }

/** Каталог прогона одной попытки — ровно там и с тем же именем файла, что оставляет тик. */
function writeReceipt(projectDir: string, attemptId: string, tokens: object | null) {
  const dir = join(projectDir, '.sma', 'runs', attemptId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'receipt.json'),
    `${JSON.stringify({ schema: 'sma-receipt/1', outcome: 'completed', tokens }, null, 2)}\n`,
    'utf8',
  )
}

// ── поддельные req/res (та же форма, которой ведут двери соседние сьюты) ────────────────────

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.9' } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
  req.socket = { remoteAddress: remote }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

async function call(front: any, o: any) {
  const req = mkReq({
    ...o,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(o.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(o.headers || {}),
    },
  })
  const res = mkRes()
  await front.handle(req, res)
  return res
}

const CLOCK = 1_770_000_000_000

/** Дверь, подключённая ровно теми сотрудниками, которых спрашивают эти четыре ответа. */
function mkFront({ projectDir, rows = [], attempts = [] }: any) {
  const enqueued: any[] = []
  const front = createFrontServer({
    config: { token: TOKEN, repoDir: projectDir },
    deps: {
      repoDir: projectDir,
      clock: () => CLOCK,
      adapter: {
        list: async () => rows,
        enqueue: async (t: any) => {
          enqueued.push(t)
          return { id: t.id, coalesced: false }
        },
      },
      ledger: {
        readAttempts: () => attempts,
        readAttemptLog: () => ({ entries: [], truncated: false, roles: [], rolesMore: 0, digest: null }),
        readJournalEntries: () => [],
      },
      derivePhaseCard,
      derivePhaseIndex,
    },
  })
  return { front, enqueued }
}

// ═══════════ ДВЕРЬ ЗАДАЧИ: СУММА ПО ВСЕМ ПОДХОДАМ ══════════════════════════════════════════

describe('GET /api/task/:id — расход задачи сложен по её попыткам', () => {
  it('две попытки с известными числами → сумма на задаче и свои числа на каждом подходе', async () => {
    const projectDir = mkProject()
    writeReceipt(projectDir, 'BL-1_1', FIRST)
    writeReceipt(projectDir, 'BL-1_2', SECOND)

    const { front } = mkFront({
      projectDir,
      rows: [{ id: 'BL-1', status: 'completed', lane: 'prod', title: 'дело', attempt: 2, priority: 0 }],
      attempts: [
        { attempt: 1, outcome: 'failed', workerId: 'max-1' },
        { attempt: 2, outcome: 'completed', workerId: 'max-1' },
      ],
    })

    const res = await call(front, { url: '/api/task/BL-1' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    // ЦЕНУ ЧЕЛОВЕК ПЛАТИТ ЗА ЗАДАЧУ, А НЕ ЗА ПОДХОД: работа со второго раза стоила двух.
    expect(body.task.tokens).toEqual(BOTH)
    expect(body.attempts.map((a: any) => a.tokens)).toEqual([FIRST, SECOND])
  })

  it('попытка старше поля даёт НОЛЬ в сумму и `null` у себя — и это не ошибка', async () => {
    const projectDir = mkProject()
    writeReceipt(projectDir, 'BL-2_1', null) // квитанция есть, чисел в ней нет
    writeReceipt(projectDir, 'BL-2_2', SECOND)

    const { front } = mkFront({
      projectDir,
      rows: [{ id: 'BL-2', status: 'completed', lane: 'prod', title: 'дело', attempt: 2, priority: 0 }],
      attempts: [
        { attempt: 1, outcome: 'failed' },
        { attempt: 2, outcome: 'completed' },
      ],
    })

    const res = await call(front, { url: '/api/task/BL-2' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    expect(body.attempts[0].tokens).toBe(null) // «эта попытка об этом молчит»
    expect(body.task.tokens).toEqual(SECOND) // и сумма остальных от этого не пострадала
  })

  it('каталога прогонов нет вовсе → честное отсутствие, а не выдуманный ноль', async () => {
    const projectDir = mkProject() // ни одной квитанции не написано
    const { front } = mkFront({
      projectDir,
      rows: [{ id: 'BL-3', status: 'completed', lane: 'prod', title: 'дело', attempt: 1, priority: 0 }],
      attempts: [{ attempt: 1, outcome: 'completed' }],
    })

    const body = JSON.parse((await call(front, { url: '/api/task/BL-3' })).body)
    expect(body.attempts[0].tokens).toBe(null)
    // Каталог прогонов задан (проект подключён), а попытка молчит: сумма — измеренный ноль.
    expect(body.task.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

// ═══════════ ДВЕРЬ ПОПЫТКИ ═════════════════════════════════════════════════════════════════

describe('GET /api/attempt/:id — экран попытки называет её расход', () => {
  it('известная квитанция → те же четыре числа в ответе двери лога', async () => {
    const projectDir = mkProject()
    writeReceipt(projectDir, 'BL-9_3', FIRST)

    const { front } = mkFront({ projectDir })
    const res = await call(front, { url: '/api/attempt/BL-9_3' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).tokens).toEqual(FIRST)
  })

  it('попытка, о которой квитанция молчит → null, а не нули', async () => {
    const { front } = mkFront({ projectDir: mkProject() })
    const res = await call(front, { url: '/api/attempt/BL-9_4' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).tokens).toBe(null)
  })
})

// ═══════════ КАРТОЧКА ФАЗЫ: СУММА ПО ЕЁ ЗАДАЧАМ ════════════════════════════════════════════

describe('GET /api/phase/:id — расход фазы сложен по её задачам', () => {
  it('две задачи одной фазы → сумма двух, и каждая со всеми своими подходами', async () => {
    const projectDir = mkProject()
    mkdirSync(join(projectDir, '.planning', 'phases', '12-front'), { recursive: true })
    writeFileSync(join(projectDir, '.planning', 'phases', '12-front', '12-CONTEXT.md'), '# контекст\n', 'utf8')
    writeReceipt(projectDir, 'S-1_1', FIRST)
    writeReceipt(projectDir, 'S-2_1', SECOND)
    // Задача ЧУЖОЙ фазы с щедрой квитанцией — в сумму этой фазы попасть не должна.
    writeReceipt(projectDir, 'S-3_1', { input: 9999, output: 9999, cacheRead: 9999, cacheWrite: 9999 })

    const rows = [
      { id: 'S-1', status: 'completed', lane: 'paperwork', title: 'обсуждение', attempt: 1, data: { kind: 'document', stage: 'discuss', phase: '12' } },
      { id: 'S-2', status: 'completed', lane: 'paperwork', title: 'план', attempt: 1, data: { kind: 'document', stage: 'plan', phase: '12' } },
      { id: 'S-3', status: 'completed', lane: 'paperwork', title: 'чужая фаза', attempt: 1, data: { kind: 'document', stage: 'plan', phase: '13' } },
    ]

    const { front } = mkFront({ projectDir, rows })
    const res = await call(front, { url: '/api/phase/12' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).tokens).toEqual(BOTH)
  })

  it('фаза, о задачах которой спросить не у кого → отсутствие суммы', () => {
    const projectDir = mkProject()
    mkdirSync(join(projectDir, '.planning', 'phases', '12-front'), { recursive: true })
    writeFileSync(join(projectDir, '.planning', 'phases', '12-front', '12-CONTEXT.md'), '# контекст\n', 'utf8')

    const card = derivePhaseCard({ projectDir, phaseId: '12' })
    expect(card).not.toBe(null)
    expect(card.tokens).toBe(null)
  })
})

// ═══════════ БАТЧ: СУММА ПО КУСКАМ И МОМЕНТ ПРОСЬБЫ ВЛАДЕЛЬЦА ══════════════════════════════

const batchRows = (requestedAt: number | undefined) => [
  {
    id: 'B-7',
    batchId: 'B-7',
    status: 'queued',
    lane: 'prod',
    title: 'сборка',
    priority: 0,
    data: requestedAt === undefined ? { batch: 'parent' } : { batch: 'parent', requestedAt },
  },
  { id: 'B-7-1', batchId: 'B-7', status: 'completed', lane: 'prod', title: 'кусок 1', attempt: 1, priority: 0 },
  { id: 'B-7-2', batchId: 'B-7', status: 'completed', lane: 'prod', title: 'кусок 2', attempt: 1, priority: 0 },
]

describe('проекция батча — расход сборки и момент, когда её попросили', () => {
  it('батч из двух задач → сумма двух, и момент просьбы в проекции', async () => {
    const projectDir = mkProject()
    writeReceipt(projectDir, 'B-7-1_1', FIRST)
    writeReceipt(projectDir, 'B-7-2_1', SECOND)

    const payload = await deriveState({
      adapter: { list: async () => batchRows(CLOCK) },
      config: {},
      repoDir: projectDir,
      clock: () => CLOCK,
    } as any)

    expect(payload.batches).toHaveLength(1)
    expect(payload.batches[0].tokens).toEqual(BOTH)
    expect(payload.batches[0].requestedAt).toBe(CLOCK)
  })

  it('строка, записанная до этого поля, честно молчит о моменте', async () => {
    const payload = await deriveState({
      adapter: { list: async () => batchRows(undefined) },
      config: {},
      repoDir: mkProject(),
      clock: () => CLOCK,
    } as any)

    expect(payload.batches[0].requestedAt).toBe(null)
  })
})

describe('POST /api/batch — дверь доносит момент создания до строки', () => {
  it('момент просьбы записан на строку запроса тем же числом, каким назван батч', async () => {
    const { front, enqueued } = mkFront({ projectDir: mkProject() })
    const res = await call(front, {
      method: 'POST',
      url: '/api/batch',
      body: { title: 'три дела', items: ['первое', 'второе'] },
    })
    expect(res.statusCode).toBe(200)

    const request = enqueued.find((t: any) => t.data && t.data.batch === 'parent')
    expect(request.data.requestedAt).toBe(CLOCK)
    // ОДИН ВЫЗОВ ЧАСОВ: имя сборки и момент просьбы не имеют права разойтись.
    expect(request.id).toBe(`B-${CLOCK}`)
  })
})

// ═══════════ ТАБЛИЦА МАРШРУТОВ НЕ ТРОНУТА ══════════════════════════════════════════════════

describe('числа приехали полезной нагрузкой, а не новой дверью', () => {
  it('четыре двери названы теми же маршрутами, и ни один маршрут не заведён под расход', () => {
    const { front } = mkFront({ projectDir: mkProject() })
    const routes: Record<string, string> = front.routes

    expect(routes['GET /api/task/:id']).toBe('handleTask')
    expect(routes['GET /api/attempt/:id']).toBe('handleAttempt')
    expect(routes['GET /api/phase/:id']).toBe('handlePhaseCard')
    expect(routes['POST /api/batch']).toBe('handleBatchCreate')

    for (const route of Object.keys(routes)) {
      expect(route.toLowerCase()).not.toContain('token')
      expect(route.toLowerCase()).not.toContain('spend')
      expect(route.toLowerCase()).not.toContain('usage')
    }
  })
})
