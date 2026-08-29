/**
 * ВОРОТА СТУПЕНИ ДИЗАЙНА И КОНВЕРТ ВОЗВРАТА — провода, а не вычисления.
 *
 * ═══════════════ ЗАЧЕМ ЭТОТ СЬЮТ СУЩЕСТВУЕТ ОТДЕЛЬНО ═══════════════════════════════════
 * Ступень дизайна имеет смысл ровно в одном случае: пока чертёж не подтверждён человеком,
 * КОД НЕ ПИШЕТСЯ. Это утверждение нельзя проверить чтением словаря стадий — словарь знает
 * только имена. Оно проверяется дверью: диспатч исполнения обязан ОТКАЗАТЬ. Поэтому здесь
 * поднимается настоящая дверь над настоящей очередью, и утверждается ПРОВОД:
 *
 *   А. КОНВЕРТ ВОЗВРАТА. Документарная задача, вернувшаяся на переделку, обязана остаться
 *      документарной. Сегодня она ею не остаётся: дверь возврата ставит строку заново с
 *      `lane: v.lane || 'prod'` и БЕЗ `data`, а очередь при повторной постановке под тем же
 *      номером (строка уже не `queued`) не наследует запись, а ПЕРЕЗАПИСЫВАЕТ её целиком —
 *      см. `enqueue` в queue/adapter.mjs. Значит возвращённый чертёж уезжает в чужую полосу
 *      без конверта, и тик больше не знает, каким гейтом его судить.
 *   Б. ВОРОТА ИСПОЛНЕНИЯ, пять исходов — от «дизайна не было вовсе» до «фаза шла ещё до
 *      того, как ступень появилась» (её задним числом не запирают).
 *   В. ВЕРСИЯ ПОВЕРХ ПОДТВЕРЖДЁННОЙ: новый чертёж снова закрывает исполнение.
 *   Г. ЕДИНСТВЕННОЕ ОБРАТНОЕ РЕБРО: из дизайна можно уйти назад в планирование и никуда
 *      больше. Причина словами едет планировщику ДАННЫМИ, а не распоряжением.
 *   Д. ПРОЕКЦИЯ: у фазы, чьё исполнение началось раньше ступени, дизайн — «пропущен», и это
 *      четвёртое слово статуса, а не молчаливое «не начата».
 *
 * КАКИМ СЛОВОМ ОЧЕРЕДЬ НАЗЫВАЕТ ПОДТВЕРЖДЕНИЕ. Закрытый словарь статуса строки (TASK_STATUSES)
 * своими словами говорит: `completed` — «человек сказал да». Долговечная очередь так и отвечает
 * — её `statusOf` переводит принятую строку приёмки ровно в `completed`, а собственное слово
 * таблицы попыток (`approved`, куда CAS-ит дверь приёмки) наружу НЕ выпускает. Поэтому ворота
 * спрашивают строку и принимают оба слова: два этажа правды называют один факт, и дверь,
 * знающая только слово таблицы, отказывала бы КАЖДОМУ честно подтверждённому дизайну в бою.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createFrontServer } from '../src/front/server.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { derivePhaseCard, stagesOf } from '../src/front/state.mjs'
import { EXEC_CHECKPOINT_SUFFIX } from '../src/front/questions.mjs'
import { stageCommand } from '../src/policy/phase-cycle.mjs'

const TOKEN = 'g'.repeat(64)
const PROJECT = '/proj'
const PHASE = '21'
const DIR = `${PROJECT}/.planning/phases/${PHASE}-risovanie`
const NOW = 1_770_000_000_000

// ── дерево в памяти (форма фикстур front-phase.test.ts, не изобретённая заново) ──

type Tree = Record<string, string>

function norm(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

function fakeFs(initial: Tree) {
  const files = new Map<string, string>()
  for (const [k, v] of Object.entries(initial)) files.set(norm(k), v)

  const dirSet = () => {
    const dirs = new Set<string>(['/'])
    for (const p of files.keys()) {
      const parts = p.split('/')
      parts.pop()
      let acc = ''
      for (const part of parts) {
        acc = acc === '' ? (part === '' ? '/' : part) : acc === '/' ? `/${part}` : `${acc}/${part}`
        dirs.add(acc)
      }
    }
    return dirs
  }

  return {
    existsSync(p: string) {
      const k = norm(p)
      return files.has(k) || dirSet().has(k)
    },
    readdirSync(p: string) {
      const k = norm(p)
      if (!dirSet().has(k)) throw new Error(`ENOENT: ${k}`)
      const prefix = k === '/' ? '/' : `${k}/`
      const out = new Set<string>()
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        if (rest === '') continue
        out.add(rest.split('/')[0])
      }
      return [...out].sort()
    },
    readFileSync(p: string) {
      const k = norm(p)
      if (!files.has(k)) throw new Error(`ENOENT: ${k}`)
      return files.get(k) as string
    },
    statSync(p: string) {
      const k = norm(p)
      const isFile = files.has(k)
      if (!isFile && !dirSet().has(k)) throw new Error(`ENOENT: ${k}`)
      return { isDirectory: () => !isFile, isFile: () => isFile }
    },
    mkdirSync() {},
    writeFileSync(p: string, text: string) {
      files.set(norm(p), String(text))
    },
    renameSync() {},
    unlinkSync(p: string) {
      files.delete(norm(p))
    },
  }
}

/** Фаза, у которой ещё ничего не происходило: только разговор. */
const barePhase = () => fakeFs({ [`${DIR}/${PHASE}-CONTEXT.md`]: '# о чём фаза' })

/** Фаза, чьё исполнение УЖЕ ЗАКОНЧИЛОСЬ до появления ступени: итог на диске, чертежа нет. */
const workedPhase = () =>
  fakeFs({
    [`${DIR}/${PHASE}-CONTEXT.md`]: '# о чём фаза',
    [`${DIR}/${PHASE}-01-PLAN.md`]: '# план',
    [`${DIR}/${PHASE}-01-SUMMARY.md`]: '# итог',
  })

/** Фаза, чьё исполнение ИДЁТ прямо сейчас: чекпойнт есть, итога ещё нет. */
const startedPhase = () =>
  fakeFs({
    [`${DIR}/${PHASE}-CONTEXT.md`]: '# о чём фаза',
    [`${DIR}/${PHASE}-01-PLAN.md`]: '# план',
    [`${DIR}/${PHASE}${EXEC_CHECKPOINT_SUFFIX}`]: JSON.stringify({ decisions: {} }),
  })

// ── дверь ──

function mkReq(url: string, body?: unknown) {
  const req: any = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '10.0.0.4' }
  return req
}

function mkRes() {
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
    getHeader() {
      return undefined
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

async function post(front: any, url: string, body: unknown) {
  const res = mkRes()
  await front.handle(mkReq(url, body), res)
  return res
}

/**
 * CAS-шов с НАСТОЯЩЕЙ семантикой from/to: выигрывает только переход из того состояния, в
 * котором строка стоит. Начальное состояние берётся у очереди — единственного места, где оно
 * вообще есть. Шов, отвечающий «выиграл» на что угодно, доказывал бы, что дверь дошла до
 * enqueue, и ничего не доказывал бы о том, при каком состоянии она туда доходит.
 */
function casSeam(adapter: any) {
  const states = new Map<string, string>()
  const moves: Array<{ id: string; from: string; to: string }> = []
  const execSql = async (_sql: string, params: any[]) => {
    const to = params[0]
    const from = params[params.length - 1]
    const id = params[params.length - 2]
    if (!states.has(id)) {
      const rows = await adapter.list({})
      const row = rows.find((r: any) => r.id === id)
      states.set(id, row ? row.status : 'unknown')
    }
    if (states.get(id) !== from) return { rows: [] }
    states.set(id, to)
    moves.push({ id, from, to })
    return { rows: [{ id }] }
  }
  return { execSql, moves }
}

/** Настоящая очередь плюс запись того, ЧТО дверь ей передала (заметка на строку не выходит). */
function spied(adapter: any) {
  const enqueued: any[] = []
  return {
    enqueued,
    queue: {
      ...adapter,
      enqueue: async (t: any) => {
        enqueued.push(t)
        return adapter.enqueue(t)
      },
    },
  }
}

function mkFront(opts: any = {}) {
  const enqueued: any[] = opts.enqueued ?? []
  const emitted: any[] = []
  const io = opts.io ?? barePhase()
  const rows: any[] = opts.rows ?? []
  const queue =
    opts.adapter ??
    ({
      enqueue: async (t: any) => {
        enqueued.push(t)
        return { id: t.id, coalesced: false }
      },
      list: async () => rows,
    } as any)
  const front = createFrontServer({
    config: { token: TOKEN },
    deps: {
      repoDir: PROJECT,
      fsImpl: io,
      clock: opts.clock ?? (() => NOW),
      adapter: queue,
      hub: { emit: (e: any) => emitted.push(e) },
      ...(opts.noCard === true ? {} : { derivePhaseCard }),
      ...(opts.casExec ? { casExec: opts.casExec } : {}),
    },
  })
  return { front, enqueued, emitted }
}

/** Строка ступени дизайна этой фазы — конверт настоящий, статус по вкусу кейса. */
const designRow = (over: any = {}) => ({
  id: 'S-100',
  source: 'roster',
  lane: 'paperwork',
  title: stageCommand('design', PHASE),
  status: 'completed',
  enqueuedAt: 100,
  attempt: 1,
  data: { kind: 'document', stage: 'design', phase: PHASE },
  ...over,
})

/** Довести задачу очереди до «ждёт решения человека» настоящими вызовами очереди. */
async function toAwaitingApproval(adapter: any, id: string) {
  const claimed = await adapter.claimNext('w-1', {})
  expect(claimed?.id, 'работник не смог взять задачу').toBe(id)
  await adapter.complete(id, { receiptRef: 'artifact:.planning/x@abc', attemptToken: claimed.attemptToken })
  const [row] = (await adapter.list({})).filter((r: any) => r.id === id)
  expect(row.status).toBe('awaiting_approval')
}

// ═══════════════ А · КОНВЕРТ ВОЗВРАТА ПЕРЕЖИВАЕТ ВОЗВРАТ ═══════════════════════════════

describe('А · возвращённая документарная задача остаётся документарной', () => {
  it('строка встаёт обратно в очередь СО СВОЕЙ полосой и СО СВОИМ конвертом', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const spy = spied(adapter)
    const cas = casSeam(adapter)
    const { front } = mkFront({ adapter: spy.queue, casExec: cas.execSql })

    const started = await post(front, '/api/phase/stage', { phase: PHASE, stage: 'design' })
    const id = JSON.parse(started.body).taskId
    await toAwaitingApproval(adapter, id)

    const res = await post(front, '/api/return', { taskId: id, note: 'в чертеже дыра: пустой список не нарисован' })

    expect(res.statusCode).toBe(200)
    const [row] = (await adapter.list({})).filter((r: any) => r.id === id)
    expect(row.status, 'задача не вернулась в очередь вовсе').toBe('queued')
    expect(row.lane, 'документарная задача уехала в чужую полосу').toBe('paperwork')
    expect(row.data, 'конверт стадии потерян — тик больше не знает, каким гейтом судить').toEqual({
      kind: 'document',
      stage: 'design',
      phase: PHASE,
    })
    expect(row.attempt).toBe(2)
    // заметка человека — ДАННЫЕ задачи; на строку чтения она не выходит, поэтому спрашиваем
    // то, что дверь передала очереди
    expect(spy.enqueued[spy.enqueued.length - 1].note).toContain('дыра')
  })

  it('возврат ОБЫЧНОЙ работы по-прежнему едет своей полосой и конверта не выдумывает', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await adapter.enqueue({ id: 'R-7', source: 'roster', title: 'починить импорт', lane: 'prod' })
    await toAwaitingApproval(adapter, 'R-7')
    const cas = casSeam(adapter)
    const { front } = mkFront({ adapter, casExec: cas.execSql })

    expect((await post(front, '/api/return', { taskId: 'R-7', note: 'переделай' })).statusCode).toBe(200)

    const [row] = await adapter.list({})
    expect(row.lane).toBe('prod')
    expect(row.data).toBeUndefined()
  })
})

// ═══════════════ Б · ВОРОТА ИСПОЛНЕНИЯ, ПЯТЬ ИСХОДОВ ══════════════════════════════════

describe('Б · исполнение не стартует, пока дизайн не подтверждён', () => {
  it('1 · дизайна не было вовсе, фаза не начиналась — 409 словами, и в очередь ничего не легло', async () => {
    const { front, enqueued } = mkFront({ io: barePhase(), rows: [] })
    const res = await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('не подтверждён')
    expect(enqueued).toHaveLength(0)
  })

  it('2 · свежейшая строка дизайна подтверждена — дверь пропускает и ставит работу как всегда', async () => {
    const { front, enqueued } = mkFront({ io: barePhase(), rows: [designRow({ status: 'completed' })] })
    const res = await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })
    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].data).toEqual({ kind: 'code', stage: 'execute', phase: PHASE })
  })

  it('3 · дизайн идёт или ждёт решения — 409, и отказ называет фактический статус', async () => {
    for (const status of ['queued', 'claimed', 'awaiting_approval']) {
      const { front, enqueued } = mkFront({ io: barePhase(), rows: [designRow({ status })] })
      const res = await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })
      expect(res.statusCode, status).toBe(409)
      expect(res.body, status).toContain(status)
      expect(enqueued, status).toHaveLength(0)
    }
  })

  it('3-бис · сорвавшийся дизайн подтверждением не считается', async () => {
    const { front, enqueued } = mkFront({ io: barePhase(), rows: [designRow({ status: 'failed' })] })
    expect((await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })).statusCode).toBe(409)
    expect(enqueued).toHaveLength(0)
  })

  it('4 · ГРАНДФАЗЕР: у фазы, которая уже отработала до появления ступени, чертежа не спрашивают', async () => {
    const { front, enqueued } = mkFront({ io: workedPhase(), rows: [] })
    expect((await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })).statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
  })

  it('5 · ГРАНДФАЗЕР идущей фазы: исполнение НАЧАЛОСЬ, итога ещё нет — переспуск не запирают', async () => {
    const { front, enqueued } = mkFront({ io: startedPhase(), rows: [] })
    expect((await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })).statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
  })

  it('ворота НЕ трогают остальные ступени: разговор, план, дизайн и приёмка ставятся как прежде', async () => {
    for (const stage of ['discuss', 'plan', 'design', 'verify']) {
      const { front, enqueued } = mkFront({ io: barePhase(), rows: [] })
      expect((await post(front, '/api/phase/stage', { phase: PHASE, stage })).statusCode, stage).toBe(200)
      expect(enqueued, stage).toHaveLength(1)
    }
  })

  it('FAIL-CLOSED: проекции нет — дверь отказывает, а не пропускает «на всякий случай»', async () => {
    const noCard = mkFront({ io: barePhase(), rows: [], noCard: true })
    expect((await post(noCard.front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })).statusCode).toBe(409)
    expect(noCard.enqueued).toHaveLength(0)

    // фазы с таким номером в дереве нет вовсе — карточка `null`, и это тоже отказ
    const noPhase = mkFront({ io: workedPhase(), rows: [] })
    expect((await post(noPhase.front, '/api/phase/stage', { phase: '77', stage: 'execute' })).statusCode).toBe(409)
    expect(noPhase.enqueued).toHaveLength(0)
  })

  it('НЕТ КОНФИГ-ТРОПЫ В ОБХОД: ключ тела, открывающий ворота, — 400, а не тихий пропуск', async () => {
    const { front, enqueued } = mkFront({ io: barePhase(), rows: [] })
    const res = await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute', force: true })
    expect(res.statusCode).toBe(400)
    expect(enqueued).toHaveLength(0)
  })
})

// ═══════════════ В · НОВАЯ ВЕРСИЯ ЧЕРТЕЖА СНОВА ЗАКРЫВАЕТ ИСПОЛНЕНИЕ ═══════════════════

describe('В · подтверждение относится к ТОЙ версии чертежа, которую подтверждали', () => {
  it('поверх принятого дизайна поставлен новый — исполнение снова закрыто', async () => {
    const rows = [
      designRow({ id: 'S-100', status: 'completed', enqueuedAt: 100 }),
      designRow({ id: 'S-200', status: 'queued', enqueuedAt: 200 }),
    ]
    const { front, enqueued } = mkFront({ io: barePhase(), rows })
    const res = await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })
    expect(res.statusCode).toBe(409)
    expect(enqueued).toHaveLength(0)
  })

  it('и открывается снова, когда подтверждена именно свежейшая', async () => {
    const rows = [
      designRow({ id: 'S-100', status: 'failed', enqueuedAt: 100 }),
      designRow({ id: 'S-200', status: 'completed', enqueuedAt: 200 }),
    ]
    const { front, enqueued } = mkFront({ io: barePhase(), rows })
    expect((await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })).statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
  })

  it('строки ДРУГОЙ фазы и других ступеней воротам этой фазы не отвечают', async () => {
    const rows = [
      designRow({ id: 'S-1', status: 'completed', data: { kind: 'document', stage: 'design', phase: '77' } }),
      designRow({ id: 'S-2', status: 'completed', data: { kind: 'document', stage: 'plan', phase: PHASE } }),
    ]
    const { front, enqueued } = mkFront({ io: barePhase(), rows })
    expect((await post(front, '/api/phase/stage', { phase: PHASE, stage: 'execute' })).statusCode).toBe(409)
    expect(enqueued).toHaveLength(0)
  })
})

// ═══════════════ Г · ЕДИНСТВЕННОЕ ОБРАТНОЕ РЕБРО: ДИЗАЙН → ПЛАНИРОВАНИЕ ═══════════════

describe('Г · из дизайна можно вернуть работу в планирование — и больше никуда', () => {
  async function parkedDesign() {
    let now = NOW
    const adapter = createMemoryQueue({ clock: () => now, expireMs: 300000 })
    const spy = spied(adapter)
    const cas = casSeam(adapter)
    const { front, emitted } = mkFront({ adapter: spy.queue, casExec: cas.execSql, clock: () => now })
    const started = await post(front, '/api/phase/stage', { phase: PHASE, stage: 'design' })
    const id = JSON.parse(started.body).taskId
    await toAwaitingApproval(adapter, id)
    now += 60_000 // человек думал минуту — номер новой строки не может совпасть со старым
    return { front, adapter, spy, id, emitted }
  }

  it('to_stage «в планирование» закрывает чертёж и ставит НОВУЮ задачу планирования с причиной', async () => {
    const { front, adapter, spy, id } = await parkedDesign()

    const res = await post(front, '/api/return', {
      taskId: id,
      note: 'дыра в плане: экран пустого списка нигде не назван',
      to_stage: 'plan',
    })

    expect(res.statusCode).toBe(200)
    const rows = await adapter.list({})
    const fresh = rows.filter((r: any) => r.id !== id)
    expect(fresh, 'новой задачи планирования не появилось').toHaveLength(1)
    expect(fresh[0].title).toBe(stageCommand('plan', PHASE))
    expect(fresh[0].lane).toBe('paperwork')
    expect(fresh[0].data).toEqual({ kind: 'document', stage: 'plan', phase: PHASE })
    expect(fresh[0].status).toBe('queued')
    // причина словами доезжает до планировщика ДАННЫМИ
    expect(spy.enqueued[spy.enqueued.length - 1].note).toContain('дыра в плане')
    expect(spy.enqueued[spy.enqueued.length - 1].source).toBe('return')
    // ответ двери называет номер новой задачи — иначе окно не знает, за чем следить
    expect(JSON.parse(res.body).taskId).toBe(id)
    expect(String(JSON.parse(res.body).stageTaskId ?? '')).toBe(fresh[0].id)
    // и ЧЕРТЁЖ ОБРАТНО В ОЧЕРЕДЬ НЕ ВСТАЛ: возврат его закрыл, переделывать нечего
    expect(rows.filter((r: any) => r.id === id)[0].status).not.toBe('queued')
  })

  it('адресат, которого у ребра нет, — 400, и работа НЕ закрыта: строка осталась ждать решения', async () => {
    const { front, adapter, id } = await parkedDesign()

    const res = await post(front, '/api/return', { taskId: id, note: 'иди работай', to_stage: 'execute' })

    expect(res.statusCode).toBe(400)
    expect(await adapter.list({})).toHaveLength(1)
    expect((await adapter.list({}))[0].status).toBe('awaiting_approval')
  })

  it('обратное ребро принадлежит ДИЗАЙНУ: у обычной работы такого адресата нет', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await adapter.enqueue({ id: 'R-9', source: 'roster', title: 'починить импорт', lane: 'prod' })
    await toAwaitingApproval(adapter, 'R-9')
    const cas = casSeam(adapter)
    const { front } = mkFront({ adapter, casExec: cas.execSql })

    const res = await post(front, '/api/return', { taskId: 'R-9', note: 'не туда', to_stage: 'plan' })

    expect(res.statusCode).toBe(400)
    expect((await adapter.list({}))[0].status).toBe('awaiting_approval')
  })

  it('обычный возврат чертежа (без to_stage) по-прежнему ПЕРЕДЕЛЫВАЕТ его, а не отправляет назад', async () => {
    const { front, adapter, id } = await parkedDesign()

    expect((await post(front, '/api/return', { taskId: id, note: 'перерисуй' })).statusCode).toBe(200)

    const rows = await adapter.list({})
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].data.stage).toBe('design')
  })

  it('задача планирования этой фазы уже жива — 409 тем же правилом, что у двери диспатча', async () => {
    const { front, adapter, id } = await parkedDesign()
    await adapter.enqueue({
      id: 'S-999',
      source: 'roster',
      title: stageCommand('plan', PHASE),
      lane: 'paperwork',
      data: { kind: 'document', stage: 'plan', phase: PHASE },
    })

    const res = await post(front, '/api/return', { taskId: id, note: 'дыра', to_stage: 'plan' })

    expect(res.statusCode).toBe(409)
    expect((await adapter.list({})).filter((r: any) => r.data?.stage === 'plan')).toHaveLength(1)
  })
})

// ═══════════════ Д · ПРОЕКЦИЯ: «ПРОПУЩЕН» — ЧЕТВЁРТОЕ СЛОВО СТАТУСА ═══════════════════

describe('Д · ступень дизайна у фазы, которая началась раньше ступени, — «пропущена»', () => {
  it('итог исполнения на диске без чертежа читается как «пропущен», а не «не начата»', () => {
    expect(stagesOf([`${PHASE}-CONTEXT.md`, `${PHASE}-01-SUMMARY.md`]).design).toBe('skipped')
  })

  it('исполнение ИДЁТ (чекпойнт есть, итога ещё нет) — тоже «пропущен»', () => {
    expect(stagesOf([`${PHASE}-CONTEXT.md`, `${PHASE}${EXEC_CHECKPOINT_SUFFIX}`]).design).toBe('skipped')
  })

  it('фаза, которая ещё не работала, ждёт чертежа честно: «не начата»', () => {
    expect(stagesOf([`${PHASE}-CONTEXT.md`, `${PHASE}-01-PLAN.md`]).design).toBe('none')
  })

  it('чертёж есть — «сделана», и никакой грандфазер его не перебивает', () => {
    expect(stagesOf([`${PHASE}-DESIGN.md`, `${PHASE}-01-SUMMARY.md`]).design).toBe('done')
  })

  it('остальные четыре ступени слова «пропущена» не получают ни при каком составе папки', () => {
    const stages = stagesOf([`${PHASE}-CONTEXT.md`, `${PHASE}-01-SUMMARY.md`])
    for (const stage of ['discuss', 'plan', 'execute', 'verify']) {
      expect(stages[stage], stage).not.toBe('skipped')
    }
  })

  it('и это слово доезжает до КАРТОЧКИ, а не остаётся во внутренней функции', () => {
    const card = derivePhaseCard({ projectDir: PROJECT, phaseId: PHASE, fsImpl: workedPhase() })
    expect(card?.stages.design).toBe('skipped')
  })
})
