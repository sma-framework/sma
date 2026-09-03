/**
 * МЕСТО РАБОТЫ В ОЧЕРЕДИ: чем оно достаётся ступени фазы, чем его переставляет человек и
 * почему у полосы обязано быть своё место.
 *
 * ПОВОД, ЗАМЕРЕННЫЙ НА ЖИВОМ ЗАПУСКЕ. Дверь ступени фазы приоритета не принимала вовсе, поэтому
 * строка ступени рождалась с нулём — то есть ПОЗАДИ всякой задачи, которой человек не поленился
 * назначить срочность. Поставленная ступень плана получила место 38 из 38 при четырёх занятых
 * местах, а её работник в ту же минуту стоял СВОБОДНЫМ; и с каждой новой постановкой с ненулевым
 * числом она уезжала ещё дальше. Чем активнее шла работа, тем позже начиналась фаза — при том
 * что ступень фазы и есть самая крупная структурная работа дома, и переставить её человеку было
 * НЕЧЕМ: двери «переставить место» не существовало, а отмена с постановкой заново стоит номера
 * строки и всей её истории.
 *
 * ВТОРОЙ СЛОЙ ТОЙ ЖЕ БОЛЕЗНИ, и он здесь же. Мест на машине одно число, общее для всех полос:
 * четыре, занятые полосой продукта, означали, что свободный работник канцелярской полосы не
 * начнёт ничего. Полосы были разведены по РАБОТНИКАМ и не разведены по МЕСТАМ — то есть
 * разведение не давало ничего, кроме имени.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ — четыре провода, а не четыре вычисления:
 *   1. ступень, поставленная при полной очереди работ с ненулевым приоритетом, БЕРЁТСЯ ПЕРВОЙ;
 *   2. дверь ступени принимает число явно, и названное число сильнее умолчания;
 *   3. дверь перестановки двигает СТРОКУ: следующая выдача берёт другую работу, чем взяла бы;
 *   4. при полном общем пуле полоса со своим местом всё равно начинает — тиком, домом мест и
 *      настоящей очередью, без подставного дома и без подставного захвата.
 *
 * Ни демона, ни базы, ни сети: очередь настоящая (памятный бэкенд — исполняемая спецификация),
 * дом мест настоящий, дверь — настоящая, поднятая тем же `createFrontServer`, что и в бою.
 */

import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { createFrontServer } from '../src/front/server.mjs'
import {
  createMemoryQueue,
  isStageTask,
  PRIORITY_LIMIT,
  STAGE_PRIORITY,
  validatePriority,
} from '../src/queue/adapter.mjs'
import { queuePriority } from '../src/intake/backlog-scan.mjs'
import { createInFlight, laneReservations, seatCeiling } from '../src/queue/in-flight.mjs'

const TOKEN = 'p'.repeat(64)
const NOW = 1_777_000_000_000

// ── дверь, поднятая как в бою: настоящий сервер, настоящая очередь за ним ──

function mkReq(o: any = {}) {
  const { method = 'POST', url = '/', body } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = {
    authorization: `Bearer ${TOKEN}`,
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
  }
  req.socket = { remoteAddress: '10.0.0.7' }
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
  const res = mkRes()
  await front.handle(mkReq(o), res)
  // Отказ этих дверей — ТЕКСТ, а не объект: слова, которые человек читает на экране. Читаем
  // ответ так, как он написан, иначе дело падало бы на каждом честном отказе.
  let json: any = null
  try {
    json = res.body ? JSON.parse(res.body) : null
  } catch {
    json = null
  }
  return { code: res.statusCode, json, text: String(res.body ?? '') }
}

function mkFront(adapter: any) {
  return createFrontServer({
    config: { token: TOKEN },
    deps: { adapter, clock: () => NOW, hub: { emit: () => {} } },
  })
}

/** Обычная работа реестра — ровно та форма, которую ставит дверь беклога. */
const work = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'обычная работа',
  lane: 'prod',
  storyPoints: 3,
  acceptance: 'зелёные тесты и квитанция',
  ...over,
})

describe('место ступени фазы: она входит ВЫШЕ обычной работы, а не позади всех', () => {
  /**
   * КРАСНЫЙ ТЕСТ ЗАЯВКИ. Очередь набита работами, каждой из которых человек назначил срочность;
   * ступень ставится ПОСЛЕДНЕЙ и обязана поехать ПЕРВОЙ. До этой правки она встала бы за всеми
   * — ровно то место 38 из 38, ради которого всё это и написано.
   */
  it('ступень, поставленная при полной очереди работ с ненулевым приоритетом, берётся первой', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    // Вся шкала реестра разом: обычная работа, «high», «urgent» и «critical».
    for (const [i, p] of [1, 2, 11, 12, 21, 22, 31, 32].entries()) {
      await q.enqueue(work({ id: `BL-${i + 1}`, priority: p }))
    }

    const started = await call(mkFront(q), {
      url: '/api/phase/stage',
      body: { phase: '21', stage: 'plan' },
    })
    expect(started.code, 'дверь ступени обязана поставить работу').toBe(200)

    const claimed: any = await q.claimNext('w1', {})
    expect(claimed.id, 'ступень фазы обязана поехать раньше всякой обычной работы').toBe(started.json.taskId)
    expect(claimed.priority).toBe(STAGE_PRIORITY)
  })

  /**
   * ОТВЕТ ДВЕРИ НАЗЫВАЕТ МЕСТО. Умолчание, о котором дверь молчит, нельзя ни проверить, ни
   * уличить — а именно неназванное умолчание и стоило фазе последнего места в очереди.
   */
  it('дверь называет место, на которое встала ступень', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const started = await call(mkFront(q), { url: '/api/phase/stage', body: { phase: '21', stage: 'design' } })
    expect(started.json.priority).toBe(STAGE_PRIORITY)
    const [row] = await q.list({})
    expect(row.priority, 'сказанное в ответе обязано стоять на строке').toBe(STAGE_PRIORITY)
  })

  it('названное человеком число сильнее умолчания — и вверх, и вниз', async () => {
    // Строка ступени зовётся моментом постановки, поэтому две ступени одной миллисекунды — это
    // одна слипшаяся строка. Каждое число проверяется в своей очереди: дело здесь про умолчание
    // и число, а не про слипание.
    const quieter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const low = await call(mkFront(quieter), {
      url: '/api/phase/stage',
      body: { phase: '21', stage: 'plan', priority: 3 },
    })
    expect(low.code).toBe(200)
    expect(low.json.priority, 'человек вправе поставить ступень и ниже умолчания').toBe(3)
    expect((await quieter.list({}))[0].priority).toBe(3)

    const louder = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const high = await call(mkFront(louder), {
      url: '/api/phase/stage',
      body: { phase: '22', stage: 'plan', priority: 500 },
    })
    expect(high.json.priority).toBe(500)
    expect((await louder.list({}))[0].priority).toBe(500)
  })

  it('дробное и запредельное число дверь не принимает — и ничего не ставит', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const front = mkFront(q)

    const fraction = await call(front, { url: '/api/phase/stage', body: { phase: '21', stage: 'plan', priority: 1.5 } })
    expect(fraction.code).toBe(400)

    const huge = await call(front, {
      url: '/api/phase/stage',
      body: { phase: '21', stage: 'plan', priority: PRIORITY_LIMIT + 1 },
    })
    expect(huge.code).toBe(400)

    expect(await q.list({}), 'отказ обязан быть ДО постановки, а не после').toHaveLength(0)
  })

  /**
   * УМОЛЧАНИЕ ЖИВЁТ В ОЧЕРЕДИ, А НЕ В ДВЕРИ, и это здесь главное: ступень ставится тремя
   * дверьми (диспатч, обратное ребро возврата, пробуждение ответом), и три написания одного
   * умолчания разошлись бы молча. Строка с конвертом ступени, поставленная НАПРЯМУЮ, встаёт
   * туда же, куда её ставит дверь.
   */
  it('строка с конвертом ступени встаёт на место ступени, какой бы дверью её ни поставили', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const stage = {
      id: 'S-2',
      source: 'roster',
      title: 'ступень, поставленная не дверью диспатча',
      lane: 'paperwork',
      data: { kind: 'document', stage: 'verify', phase: '21' },
    }
    expect(isStageTask(stage), 'конверт — единственный признак ступени, и он читается словарём').toBe(true)
    await q.enqueue(stage)
    await q.enqueue(work({ id: 'BL-9', priority: 12 }))

    const rows = await q.list({})
    expect(rows.find((r: any) => r.id === 'S-2').priority).toBe(STAGE_PRIORITY)
    expect((await q.claimNext('w1', {})).id).toBe('S-2')
  })

  /**
   * И МЕСТО СТУПЕНИ ВЫШЕ САМОГО ГРОМКОГО СЛОВА, КОТОРОЕ УМЕЕТ СКАЗАТЬ РЕЕСТР. Число выбрано
   * относительно живой шкалы срочности, а не наугад; это дело держит их вместе, чтобы новая
   * полоса срочности не перепрыгнула ступень молча.
   */
  it('место ступени стоит выше всякого числа, которое выдаёт словарь срочности реестра', () => {
    const loudest = queuePriority({ priority: 'critical', size: 'S' } as any)
    expect(loudest).toBeGreaterThan(0)
    expect(STAGE_PRIORITY).toBeGreaterThan(loudest)
  })

  it('обычная работа по-прежнему встаёт в ноль — умолчание читается по тому, ЧТО за работа', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await q.enqueue(work({ id: 'BL-77' }))
    expect((await q.list({}))[0].priority).toBe(0)
  })
})

describe('переставить место строки в очереди — дверью, а не отменой и постановкой заново', () => {
  it('переставленная строка едет раньше той, что стояла впереди, — и это ТА ЖЕ строка', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await q.enqueue(work({ id: 'BL-first', priority: 10 }))
    await q.enqueue(work({ id: 'BL-second', priority: 0 }))
    const front = mkFront(q)

    const moved = await call(front, { url: '/api/task/priority', body: { taskId: 'BL-second', priority: 20 } })
    expect(moved.code).toBe(200)
    expect(moved.json).toMatchObject({ ok: true, taskId: 'BL-second', priority: 20 })

    const claimed: any = await q.claimNext('w1', {})
    expect(claimed.id, 'следующая выдача обязана взять переставленную строку').toBe('BL-second')
    expect(claimed.attempt, 'номер подхода перестановкой не тратится — строка та же самая').toBe(1)
  })

  it('строке, чья работа кончилась, дверь отказывает словами, а не молчанием', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await q.enqueue(work({ id: 'BL-done' }))
    await q.claimNext('w1', {})
    await q.complete('BL-done', { receiptRef: 'reverify:зелено' })

    const late = await call(mkFront(q), { url: '/api/task/priority', body: { taskId: 'BL-done', priority: 5 } })
    expect(late.code, 'закрытой строке место в очереди уже ничего не даёт').toBe(409)
  })

  it('незнакомая строка — «нет такой», а не выдуманная перестановка', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const absent = await call(mkFront(q), { url: '/api/task/priority', body: { taskId: 'BL-404', priority: 5 } })
    expect(absent.code).toBe(404)
  })

  it('дверь принимает только целое число в пределах — и ключей, кроме двух, не знает', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await q.enqueue(work({ id: 'BL-2' }))
    const front = mkFront(q)

    expect((await call(front, { url: '/api/task/priority', body: { taskId: 'BL-2', priority: 2.5 } })).code).toBe(400)
    expect((await call(front, { url: '/api/task/priority', body: { taskId: 'BL-2', priority: '9' } })).code).toBe(400)
    expect(
      (await call(front, { url: '/api/task/priority', body: { taskId: 'BL-2', priority: PRIORITY_LIMIT + 1 } })).code,
    ).toBe(400)
    expect(
      (await call(front, { url: '/api/task/priority', body: { taskId: 'BL-2', priority: 5, lane: 'prod' } })).code,
      'замок на неизвестные ключи не снят',
    ).toBe(400)

    expect((await q.list({}))[0].priority, 'ни один отказ не должен был тронуть строку').toBe(0)
  })

  /**
   * ПОСЛЕДНЕЕ ЗВЕНО: место строки ДОЕЗЖАЕТ ДО ОКНА, и окно переставляет его этой же дверью.
   * Перестановка вслепую — это выбор наугад: человек не видит, откуда переставляет. Дверь
   * карточки проверяется поведением, разметка — исходником (у окна нет своего прогона, зато у
   * соседних проводов до разметки есть тот же прецедент).
   */
  it('дверь карточки называет место строки, а окно берёт его оттуда и переставляет им же', async () => {
    const q = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await q.enqueue(work({ id: 'BL-shown', priority: 10 }))
    const card = await call(mkFront(q), { method: 'GET', url: '/api/task/BL-shown' })
    expect(card.code).toBe(200)
    expect(card.json.task.priority, 'карточке нечем показать место, если дверь о нём молчит').toBe(10)

    const client = readFileSync(fileURLToPath(new URL('../../spa/src/api/client.ts', import.meta.url)), 'utf8')
    expect(client, 'у окна обязана быть дорога к двери перестановки').toContain('/api/task/priority')

    const screen = readFileSync(
      fileURLToPath(new URL('../../spa/src/screens/task-card/index.tsx', import.meta.url)),
      'utf8',
    )
    expect(screen, 'карточка обязана звать дверь перестановки, а не показывать число молча').toContain(
      'useTaskPriority',
    )
    expect(screen, 'нынешнее место читается с ответа двери, второго мнения о нём окно не заводит').toContain(
      'task?.priority',
    )
  })

  it('границы числа — очереди, а не двери: одно правило на обе дороги', () => {
    expect(() => validatePriority(1.5)).toThrow()
    expect(() => validatePriority(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => validatePriority(PRIORITY_LIMIT + 1)).toThrow()
    expect(validatePriority(-PRIORITY_LIMIT)).toBe(-PRIORITY_LIMIT)
    expect(validatePriority(0)).toBe(0)
  })
})

describe('своё место полосы: разведение по полосам, у которого есть чем распорядиться', () => {
  const twoWorkers = {
    workers: [
      { id: 'prod-1', lane: 'prod', enabled: true },
      { id: 'paper-1', lane: 'paperwork', enabled: true },
    ],
    maxConcurrentAttempts: 2,
  }

  it('умолчание закрепляет одно место за полосой, которой едут ступени фазы', () => {
    expect(laneReservations(twoWorkers)).toEqual(new Map([['paperwork', 1]]))
  })

  it('делить нечего — не закрепляется ничего: машина с одним местом берёт работу, как и брала', () => {
    const one = { workers: [{ id: 'prod-1', lane: 'prod' }], maxConcurrentAttempts: 1 }
    expect(seatCeiling(one)).toBe(1)
    expect(laneReservations(one).size).toBe(0)
  })

  it('настройка перебивает умолчание целиком, а пустая — это «не закреплять ничего»', () => {
    expect(laneReservations({ ...twoWorkers, laneSeats: {} }).size).toBe(0)
    expect(laneReservations({ ...twoWorkers, laneSeats: { research: 1 } })).toEqual(new Map([['research', 1]]))
  })

  it('полоса, которой не бывает, места не отнимает — опечатка обязана быть безвредной', () => {
    expect(laneReservations({ ...twoWorkers, laneSeats: { канцелярия: 1 } }).size).toBe(0)
  })

  /**
   * И ЗАКРЕПЛЕНИЕ ЖИВЁТ, ПОКА ПОЛОСЕ ЕСТЬ КЕМ РАБОТАТЬ. Место, придержанное для полосы, на
   * которой ни один работник не может взять работу, — это потерянная единица потолка: машина с
   * одними исполнителями продукта перестала бы брать работу вовсе. Какие полосы рабочие, знает
   * тик (он выводит это маршрутом) и передаёт сюда списком.
   */
  it('полоса, на которой некому работать, места не держит', () => {
    expect(laneReservations(twoWorkers, ['prod', 'forge']).size, 'некому — значит и держать нечего').toBe(0)
    expect(laneReservations(twoWorkers, ['prod', 'paperwork'])).toEqual(new Map([['paperwork', 1]]))
    expect(laneReservations(twoWorkers, null), 'списка нет — не фильтруем вовсе').toEqual(
      new Map([['paperwork', 1]]),
    )
  })

  it('общий пул не пустеет: полосам достаётся не больше, чем потолок без одного', () => {
    const four = {
      workers: [
        { id: 'a', lane: 'prod' },
        { id: 'b', lane: 'research' },
        { id: 'c', lane: 'paperwork' },
        { id: 'd', lane: 'forge' },
      ],
      maxConcurrentAttempts: 4,
      laneSeats: { paperwork: 3, research: 3, forge: 3 },
    }
    const reserved = laneReservations(four)
    const total = [...reserved.values()].reduce((a, b) => a + b, 0)
    expect(total, 'закрепить ВСЕ места значило бы остановить обычную работу навсегда').toBe(3)
    expect(total).toBeLessThan(seatCeiling(four))
  })

  it('общий пул кончается на закреплённое место раньше — а полоса своё место получает', () => {
    const house = createInFlight()
    const reserved = laneReservations(twoWorkers)
    const seats = seatCeiling(twoWorkers)

    const general = house.reserve(seats, { reserved })
    expect(general, 'первое место общее — его берёт кто угодно').toBeTruthy()
    house.name(general!, 'BL-1', 'prod-1', 'BL-1#1', 'prod')

    expect(house.reserve(seats, { reserved }), 'второе место закреплено за полосой — общему пулу его не отдают').toBe(
      null,
    )
    expect(house.reserve(seats, { reserved, lane: 'prod' }), 'и чужой полосе тоже: место не её').toBe(null)

    const own = house.reserve(seats, { reserved, lane: 'paperwork' })
    expect(own, 'а своей полосе — отдают, и в этом весь смысл закрепления').toBeTruthy()
    expect(house.size(), 'потолок при этом не превышен ни на одно место').toBe(seats)
    expect(house.reserve(seats, { reserved, lane: 'paperwork' }), 'второго закреплённого места у полосы нет').toBe(null)
  })

  it('полоса, уже ведущая попытку с ОБЩЕГО места, своё закреплённое не держит', () => {
    const house = createInFlight()
    const reserved = laneReservations(twoWorkers)
    const seats = seatCeiling(twoWorkers)

    const general = house.reserve(seats, { reserved })
    house.name(general!, 'S-1', 'paper-1', 'S-1#1', 'paperwork')

    const second = house.reserve(seats, { reserved })
    expect(second, 'гарантия «хотя бы одно» полосе уже выдана — держать сверх неё нечего').toBeTruthy()
  })

  it('без закрепления дом ведёт себя ровно как прежде — и отдельной дороги у полосы нет', () => {
    const house = createInFlight()
    const none = new Map<string, number>()
    expect(house.reserve(2, { reserved: none })).toBeTruthy()
    expect(house.reserve(2, { reserved: none })).toBeTruthy()
    expect(house.reserve(2, { reserved: none }), 'жёсткий потолок стоит выше всего').toBe(null)
    expect(house.reserve(2, { reserved: none, lane: 'paperwork' })).toBe(null)
  })
})
