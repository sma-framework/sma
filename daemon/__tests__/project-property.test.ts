/**
 * Кому принадлежит задача — тесты ПРОВОДОВ, а не кусков.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. Замер живой очереди показал вот что: ни одна из сорока
 * лежащих строк не несла поля проекта, а дверь чтения состояния уверенно называла проект
 * КАЖДОЙ — тот, который человек смотрел в эту секунду. Переключил проект — те же самые
 * задачи «переехали» в другой, и счётчики согласились с обоими ответами. Уверенный неверный
 * ответ хуже отсутствия ответа: по нему нельзя заметить, что ответа нет.
 *
 * Лечится это не фильтром, а фактом: проект становится свойством ЗАДАЧИ, проставленным в
 * единственный момент, когда его есть у кого спросить, — когда человек стоит у двери и
 * ставит работу. Дальше факт обязан пережить весь маршрут, и каждый стык этого маршрута
 * утверждается здесь ОТДЕЛЬНО, потому что вычисленное и подключённое — разные вещи:
 *
 *   дверь ставит штамп → validateTask довозит его в нормализованной копии →
 *   бэкенд кладёт его в данные строки → чтение строки довозит его обратно
 *
 * И столько же внимания — обратной стороне: повторная постановка ТОЙ ЖЕ задачи (возврат,
 * пробуждение круга, повтор куска пакета) наследует прежний проект и НЕ перештамповывается
 * тем, что выбрано сейчас. Иначе принадлежность снова начнёт ездить за взглядом, только
 * медленнее и незаметнее.
 *
 * Отдельно — то, чего делать НЕЛЬЗЯ: строка, у которой проекта нет, обязана остаться без
 * него. Приписать сорока лежащим строкам догадку — то же выдуманное число, только про то,
 * чья это работа.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createFrontServer } from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'
import { createPgBossQueue } from '../src/queue/pgboss-backend.mjs'
import { BATCH_PARENT, createMemoryQueue, validateTask, withStatedProject } from '../src/queue/adapter.mjs'

const TOKEN = 'a'.repeat(64)
const NOW = 1_000_000_000_000
const bearer = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })

// ── фейковые req/res, как в остальных тестах дверей ──

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.1' } = o
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
      if (h) for (const [k, v] of Object.entries(h)) res.headers[String(k).toLowerCase()] = v
      return res
    },
    setHeader(k: string, v: any) {
      res.headers[String(k).toLowerCase()] = v
    },
    getHeader(k: string) {
      return res.headers[String(k).toLowerCase()]
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

async function call(front: any, reqOpts: any) {
  const req = mkReq(reqOpts)
  const res = mkRes()
  await front.handle(req, res)
  return res
}

/** Адаптер-рекордер: записывает ровно то, что дверь передала очереди. */
function recorder(rows: any[] = []) {
  const enqueued: any[] = []
  return {
    enqueued,
    async enqueue(t: any) {
      enqueued.push(t)
      return { id: t.id, coalesced: false }
    },
    async list() {
      return rows
    },
  }
}

/** CAS-переход, который всегда выигрывает гонку — возврату больше ничего не нужно. */
const winningCas = async (_sql: string, _params: any[]) => ({ rows: [{ id: 'row' }] })

// ══════════════ дверь → очередь: штамп ставится там, где его есть у кого спросить ══════════

describe('дверь ставит проект задаче', () => {
  it('постановка при выбранном проекте: очередь получает task.project выбранного', async () => {
    const adapter = recorder()
    const front = createFrontServer({
      config: { token: TOKEN, activeProject: 'sma', projects: [{ id: 'sma', name: 'Продукт' }] },
      deps: { adapter, clock: () => 1234 },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: bearer(),
      body: { title: 'сделай отчёт', lane: 'prod' },
    })
    expect(res.statusCode).toBe(200)
    expect(adapter.enqueued[0]).toMatchObject({ id: 'R-1234', project: 'sma' })
  })

  it('выбранного проекта нет — у задачи НЕТ ключа project (ни пустой строки, ни «default»)', async () => {
    const adapter = recorder()
    const front = createFrontServer({ config: { token: TOKEN }, deps: { adapter, clock: () => 1234 } })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: bearer(),
      body: { title: 'сделай отчёт', lane: 'prod' },
    })
    expect(res.statusCode).toBe(200)
    // именно отсутствие ключа: выдуманное имя проекта читатель принял бы за факт
    expect('project' in adapter.enqueued[0]).toBe(false)
  })

  it('тело запроса проект НЕ назначает: лишний ключ отбивается до всего остального', async () => {
    const adapter = recorder()
    const front = createFrontServer({
      config: { token: TOKEN, activeProject: 'sma' },
      deps: { adapter, clock: () => 1234 },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: bearer(),
      body: { title: 'чужая работа', lane: 'prod', project: 'sma-dev' },
    })
    expect(res.statusCode).toBe(400)
    expect(adapter.enqueued).toHaveLength(0)
  })

  it('«Создатель» и стадия фазы — тоже новая работа, и тоже со штампом', async () => {
    const adapter = recorder()
    const front = createFrontServer({
      config: { token: TOKEN, activeProject: 'sma-dev' },
      deps: { adapter, clock: () => 77 },
    })
    const forge = await call(front, {
      method: 'POST',
      url: '/api/forge',
      headers: bearer(),
      body: { kind: 'agent', description: 'сделай агента-приёмщика' },
    })
    expect(forge.statusCode).toBe(202)
    expect(adapter.enqueued[0]).toMatchObject({ id: 'F-77', project: 'sma-dev' })

    const stage = await call(front, {
      method: 'POST',
      url: '/api/phase/stage',
      headers: bearer(),
      body: { phase: '7', stage: 'discuss' },
    })
    expect(stage.statusCode).toBe(200)
    expect(adapter.enqueued[1]).toMatchObject({ id: 'S-77', project: 'sma-dev' })
  })

  it('пакет: и заявка, и каждый её кусок несут один проект', async () => {
    const adapter = recorder()
    const front = createFrontServer({
      config: { token: TOKEN, activeProject: 'sma' },
      deps: { adapter, clock: () => 500, deriveBacklog: () => ({ rows: [] }) },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/batch',
      headers: bearer(),
      body: { title: 'разгреби мелочь', items: ['первое', 'второе'] },
    })
    expect(res.statusCode).toBe(200)
    expect(adapter.enqueued).toHaveLength(3)
    for (const t of adapter.enqueued) expect(t.project).toBe('sma')
  })
})

// ══════════════ повторная постановка ТОЙ ЖЕ задачи наследует, а не перештамповывает ════════

describe('возврат и повтор сохраняют прежний проект', () => {
  it('возврат: прежние строки задачи говорят «sma», выбран «sma-dev» → в очередь уходит «sma»', async () => {
    const adapter = recorder([
      { id: 'R-5', status: 'awaiting_approval', lane: 'prod', title: 'ночная задача', project: 'sma', attempt: 2 },
    ])
    const front = createFrontServer({
      config: { token: TOKEN, activeProject: 'sma-dev' },
      deps: { adapter, casExec: winningCas },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/return',
      headers: bearer(),
      body: { taskId: 'R-5', note: 'переделай шапку' },
    })
    expect(res.statusCode).toBe(200)
    // задача та же самая — она не переезжает в проект, с которого на неё посмотрели
    expect(adapter.enqueued[0]).toMatchObject({ id: 'R-5', source: 'return', project: 'sma', attempt: 3 })
  })

  it('возврат задачи, у которой проекта не было: он не появляется из выбранного', async () => {
    const adapter = recorder([
      { id: 'R-6', status: 'awaiting_approval', lane: 'prod', title: 'старая задача', attempt: 1 },
    ])
    const front = createFrontServer({
      config: { token: TOKEN, activeProject: 'sma-dev' },
      deps: { adapter, casExec: winningCas },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/return',
      headers: bearer(),
      body: { taskId: 'R-6', note: 'ещё раз' },
    })
    expect(res.statusCode).toBe(200)
    expect('project' in adapter.enqueued[0]).toBe(false)
  })

  it('повтор куска пакета: кусок возвращается со своим проектом, а не с выбранным', async () => {
    const rows = [
      { id: 'B-1', status: 'queued', lane: 'prod', title: 'разгреби мелочь', project: 'sma', batchId: 'B-1', data: { batch: BATCH_PARENT } },
      { id: 'B-1-1', status: 'failed', lane: 'prod', title: 'первое', project: 'sma', batchId: 'B-1', attempt: 1 },
    ]
    const adapter: any = recorder(rows)
    adapter.resolveBatch = async () => true
    const front = createFrontServer({
      config: { token: TOKEN, activeProject: 'sma-dev' },
      deps: { adapter },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/batch/decide',
      headers: bearer(),
      body: { batchId: 'B-1', decision: 'retry', itemId: 'B-1-1' },
    })
    expect(res.statusCode).toBe(200)
    expect(adapter.enqueued[0]).toMatchObject({ id: 'B-1-1', project: 'sma', attempt: 2 })
  })
})

// ══════════════ очередь довозит факт: постановка → данные строки → чтение ══════════════════

describe('очередь довозит проект', () => {
  it('validateTask: нормализованная копия несёт project', () => {
    const norm = validateTask({ id: 'R-1', source: 'roster', title: 'работа', lane: 'prod', project: 'sma' })
    expect(norm.project).toBe('sma')
  })

  it('validateTask: у задачи без проекта его и не появляется', () => {
    const norm = validateTask({ id: 'R-1', source: 'roster', title: 'работа', lane: 'prod' })
    expect('project' in norm).toBe(false)
  })

  it('эталонный бэкенд: поставили с проектом — прочитали с проектом', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await q.enqueue({ id: 'R-2', source: 'roster', title: 'работа', lane: 'prod', project: 'sma' })
    const [row] = await q.list({})
    expect(row.project).toBe('sma')
  })

  it('долговечный бэкенд: data.project доезжает до строки ответа', async () => {
    const q = pgWith([
      job({ id: 'R-3', source: 'roster', lane: 'prod', title: 'работа', project: 'sma' }),
      job({ id: 'R-4', source: 'roster', lane: 'prod', title: 'старая работа' }),
    ])
    const rows = await q.list({})
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]))
    expect(byId['R-3'].project).toBe('sma')
    // у строки, которая проекта не называла, ключа нет вовсе — читатель не подставляет
    expect('project' in byId['R-4']).toBe(false)
  })

  it('весь маршрут целиком: дверь → validateTask → данные задания → чтение строки', async () => {
    const sent: any[] = []
    const boss = {
      async send(_name: string, data: any) {
        sent.push(data)
        return 'job-1'
      },
    }
    const q = createPgBossQueue({
      boss,
      execSql: async (sql: string) => (sql.includes('FROM pgboss.job j') ? { rows: sent.map((d) => job(d)) } : { rows: [] }),
      clock: () => NOW,
    })
    const front = createFrontServer({
      config: { token: TOKEN, activeProject: 'sma' },
      deps: { adapter: q, clock: () => 9000 },
    })
    const res = await call(front, {
      method: 'POST',
      url: '/api/enqueue',
      headers: bearer(),
      body: { title: 'сквозная работа', lane: 'prod' },
    })
    expect(res.statusCode).toBe(200)
    // то, что реально ушло в очередь, а не то, что дверь собиралась отправить
    expect(sent[0].project).toBe('sma')
    const [row] = await q.list({})
    expect(row).toMatchObject({ id: 'R-9000', project: 'sma' })
  })
})

/** Одна pg-строка задания: ровно те колонки, которые читает список. */
function job(data: any, over: any = {}) {
  return {
    id: `job-${data.id}`,
    name: `sma.task.${data.lane || 'prod'}`,
    priority: 0,
    data,
    state: 'created',
    retry_count: 0,
    created_on: NOW,
    started_on: null,
    completed_on: null,
    output: null,
    ...over,
  }
}

/** Долговечный бэкенд поверх заданных pg-строк: настоящий mapRow, никакой базы. */
function pgWith(jobRows: any[]) {
  return createPgBossQueue({
    boss: { async send() { return 'job-x' } },
    execSql: async (sql: string) => (sql.includes('FROM pgboss.job j') ? { rows: jobRows } : { rows: [] }),
    clock: () => NOW,
  })
}

// ══════════════ чтение состояния: неизвестное остаётся неизвестным ════════════════════════

const twoProjects = {
  agingHours: 24,
  workers: [{ id: 'max-1', lane: 'prod', account: { name: 'max-1' } }],
  projects: [
    { id: 'sma', name: 'Продукт' },
    { id: 'sma-dev', name: 'Мастерская' },
  ],
  activeProject: 'sma-dev',
}

const mkAdapter = (rows: any[]) => ({ list: async () => rows })
const win = (status: string) => ({ status, resetsAt: null, pct: null, observedAt: null })
const windows = () => () => ({ 'max-1': win('open') })

const mixedRows = [
  { id: 'A-1', status: 'queued', lane: 'prod', title: 'своя у продукта', priority: 0, project: 'sma', enqueuedAt: NOW - 1000 },
  { id: 'A-2', status: 'queued', lane: 'prod', title: 'вторая у продукта', priority: 0, project: 'sma', enqueuedAt: NOW - 900 },
  { id: 'U-1', status: 'queued', lane: 'prod', title: 'проект неизвестен', priority: 0, enqueuedAt: NOW - 800 },
]

describe('окно не домысливает принадлежность', () => {
  it('строка со своим проектом отдаётся со своим', async () => {
    const payload: any = await deriveState({
      adapter: mkAdapter(mixedRows),
      windows: windows(),
      config: twoProjects,
      clock: () => NOW,
    })
    expect(payload.queue.find((r: any) => r.id === 'A-1').project).toBe('sma')
  })

  it('строка без проекта отдаётся как null — при любом выбранном проекте', async () => {
    for (const active of ['sma', 'sma-dev']) {
      const payload: any = await deriveState({
        adapter: mkAdapter(mixedRows),
        windows: windows(),
        config: { ...twoProjects, activeProject: active },
        clock: () => NOW,
      })
      const unknown = payload.queue.find((r: any) => r.id === 'U-1')
      expect('project' in unknown).toBe(true) // ключ есть — его читают
      expect(unknown.project).toBeNull() // а факта нет, и об этом говорится
    }
  })

  it('работник в составе смены: у задачи без проекта — null, а не тот, куда смотрят', async () => {
    const held = [{ id: 'U-2', status: 'claimed', lane: 'prod', title: 'кто-то её взял', workerId: 'max-1', claimedAt: NOW, lastTouch: NOW }]
    const payload: any = await deriveState({
      adapter: mkAdapter(held),
      windows: windows(),
      config: twoProjects,
      clock: () => NOW,
    })
    expect(payload.workers.find((w: any) => w.id === 'max-1').project).toBeNull()
  })

  it('счётчики проектов считаются по СОБСТВЕННОМУ проекту строк', async () => {
    const payload: any = await deriveState({
      adapter: mkAdapter(mixedRows),
      windows: windows(),
      config: twoProjects,
      clock: () => NOW,
    })
    const byId = Object.fromEntries(payload.projects.map((p: any) => [p.id, p]))
    expect(byId['sma'].taskCounts.total).toBe(2)
    // выбран sma-dev, и у него честный ноль: ни одна строка не сказала, что она его
    expect(byId['sma-dev'].taskCounts.total).toBe(0)
  })

  it('сужение по проекту: свои строки И неизвестные; чужие выпадают', async () => {
    const withOther = [
      ...mixedRows,
      { id: 'D-1', status: 'queued', lane: 'prod', title: 'у мастерской', priority: 0, project: 'sma-dev', enqueuedAt: NOW - 700 },
    ]
    const payload: any = await deriveState({
      adapter: mkAdapter(withOther),
      windows: windows(),
      config: twoProjects,
      project: 'sma',
      clock: () => NOW,
    })
    expect(payload.queue.map((r: any) => r.id).sort()).toEqual(['A-1', 'A-2', 'U-1'])
  })

  it('сужение по другому проекту: неизвестная строка ВИДНА и не перекрашена', async () => {
    const payload: any = await deriveState({
      adapter: mkAdapter(mixedRows),
      windows: windows(),
      config: twoProjects,
      project: 'sma-dev',
      clock: () => NOW,
    })
    const ids = payload.queue.map((r: any) => r.id)
    // работа, которую прячет каждый фильтр, — невидимая работа; честное «неизвестен» лучше
    expect(ids).toEqual(['U-1'])
    expect(payload.queue[0].project).toBeNull()
  })
})

// ══════════════ и та же подстановка там, где её оставили: эталонный бэкенд и эшелон ═══════

/**
 * ДВА МЕСТА, НАЙДЕННЫЕ ПОСЛЕ ТОГО, КАК СТРОКИ УЖЕ ПОЧИНИЛИ.
 *
 * Первое — эталонный (в памяти) бэкенд. Он не служебная заглушка: по нему написан контракт
 * очереди, и долговечный бэкенд проверяется на соответствие ЕМУ. Пока он дополняет строку без
 * проекта текущим выбранным, спецификация описывает поведение, которого у настоящей очереди
 * больше нет, и следующий тест, написанный «по спецификации», закодирует ровно ту ложь,
 * которую эта работа убирает.
 *
 * Второе — эшелон. Проект у волны подставлялся тем же способом («выбранный, а нет — так
 * „default“»), только этажом выше: не строке, а группе строк. Волна принадлежит проекту
 * тогда, когда её собственная работа его называет, и никак иначе.
 */
describe('эталонный бэкенд не дополняет прочитанное', () => {
  it('чистая функция чтения: нет проекта — null, есть проект — свой, пусто — пусто', () => {
    expect(withStatedProject({ id: 'R-old', lane: 'prod' }).project).toBeNull()
    expect(withStatedProject({ id: 'R-old', lane: 'prod', project: 'sma' }).project).toBe('sma')
    expect(withStatedProject(null)).toBeNull()
    // ключ есть всегда — читателю нужно отличать «поля нет» от «факта нет»
    expect('project' in (withStatedProject({ id: 'R-old' }) as any)).toBe(true)
  })

  it('строка без проекта читается из очереди с project: null — и списком, и при выдаче работнику', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await q.enqueue({ id: 'R-nul', source: 'roster', title: 'ничья работа', lane: 'prod' })
    const [row] = await q.list({})
    expect(row.project).toBeNull()
    const claimed: any = await q.claimNext('max-1', {})
    expect(claimed.project).toBeNull()
  })

  it('регрессия запрещена: штамп постановки жив, свой проект доезжает до обоих чтений', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000, activeProject: 'sma' })
    await q.enqueue({ id: 'R-own', source: 'roster', title: 'работа продукта', lane: 'prod' })
    await q.enqueue({ id: 'R-oth', source: 'roster', title: 'чужая работа', lane: 'prod', project: 'sma-dev' })
    const byId = Object.fromEntries((await q.list({})).map((r: any) => [r.id, r]))
    expect(byId['R-own'].project).toBe('sma')
    expect(byId['R-oth'].project).toBe('sma-dev')
  })

  // Сужение эталонного бэкенда обязано отвечать ровно то же, что отвечает чтение состояния
  // после того, как строки починили: своё — своим, безымянное — видно под любым сужением.
  // Пока здесь действовало прежнее правило («проекта нет — значит текущий, а нет текущего —
  // значит „default“»), спецификация очереди описывала поведение, которого у настоящей
  // очереди больше нет.
  it('сужение: строка без проекта видна под ЛЮБЫМ сужением — она не принадлежит никому', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await q.enqueue({ id: 'R-nobody', source: 'roster', title: 'ничья работа', lane: 'prod' })
    for (const narrow of ['sma', 'sma-dev', 'default']) {
      expect((await q.list({ project: narrow })).map((r: any) => r.id)).toEqual(['R-nobody'])
    }
  })

  it('сужение: строка со своим проектом попадает только в своё сужение', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000, activeProject: 'sma-dev' })
    await q.enqueue({ id: 'R-mine', source: 'roster', title: 'работа продукта', lane: 'prod', project: 'sma' })
    expect((await q.list({ project: 'sma' })).map((r: any) => r.id)).toEqual(['R-mine'])
    expect(await q.list({ project: 'sma-dev' })).toEqual([])
    expect(await q.list({ project: 'default' })).toEqual([])
  })

  it('сужение: своя, чужая и безымянная вместе — остаются своя и безымянная', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await q.enqueue({ id: 'R-a', source: 'roster', title: 'своя', lane: 'prod', project: 'sma' })
    await q.enqueue({ id: 'R-b', source: 'roster', title: 'чужая', lane: 'prod', project: 'sma-dev' })
    await q.enqueue({ id: 'R-u', source: 'roster', title: 'ничья', lane: 'prod' })
    const ids = (await q.list({ project: 'sma' })).map((r: any) => r.id).sort()
    expect(ids).toEqual(['R-a', 'R-u'])
  })

  it('сужения нет — отдаются все проекты, как было', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000, activeProject: 'sma' })
    await q.enqueue({ id: 'R-1', source: 'roster', title: 'своя', lane: 'prod' })
    await q.enqueue({ id: 'R-2', source: 'roster', title: 'чужая', lane: 'prod', project: 'sma-dev' })
    expect((await q.list({})).map((r: any) => r.id).sort()).toEqual(['R-1', 'R-2'])
  })
})

describe('эшелон не домысливает принадлежность', () => {
  const wave = (id: string, phase: string, w: string, project?: string) => ({
    id,
    status: 'queued',
    lane: 'prod',
    title: id,
    priority: 0,
    enqueuedAt: NOW - 1000,
    data: { phase, wave: w },
    ...(project ? { project } : {}),
  })
  const wavesOf = async (rows: any[]) => {
    const payload: any = await deriveState({
      adapter: mkAdapter(rows),
      windows: windows(),
      config: twoProjects, // выбран «sma-dev» — именно его подставляли раньше
      clock: () => NOW,
    })
    return Object.fromEntries(payload.waves.map((w: any) => [`${w.phase}/${w.wave}`, w]))
  }

  it('вся работа эшелона называет один проект — эшелон отдаётся с ним', async () => {
    const byKey = await wavesOf([wave('W-1', '17', '1', 'sma'), wave('W-2', '17', '1', 'sma')])
    expect(byKey['17/1'].project).toBe('sma')
  })

  it('работа эшелона проекта не называет — эшелон отдаётся с project: null, а не с выбранным', async () => {
    const byKey = await wavesOf([wave('W-3', '18', '2'), wave('W-4', '18', '2')])
    expect(byKey['18/2'].project).toBeNull()
    expect(byKey['18/2'].project).not.toBe(twoProjects.activeProject)
  })

  it('эшелон из разных проектов ничей: назвать один было бы выдумкой', async () => {
    const byKey = await wavesOf([wave('W-5', '19', '3', 'sma'), wave('W-6', '19', '3', 'sma-dev')])
    expect(byKey['19/3'].project).toBeNull()
  })
})
