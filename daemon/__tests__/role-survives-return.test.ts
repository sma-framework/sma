/**
 * РОЛЬ ПЕРЕЖИВАЕТ ВОЗВРАТ — ИНАЧЕ ЧЕЛОВЕК ПРОСИЛ ИССЛЕДОВАТЕЛЯ, А ВТОРУЮ ПОПЫТКУ ВЁЛ ИСПОЛНИТЕЛЬ.
 *
 * ═══════════════════════ ОТКУДА ЭТОТ ФАЙЛ ══════════════════════════════════════════════════
 * Аудит правила «одна сборка — один работник» искал места, где ИСПОЛНИТЕЛЯ подменяют
 * МОЛЧА. В маршруте таких мест не осталось: закрепление, отпущенное ролью, названо словами
 * (`batch.pin_let_go`, см. `batch-pin-wire.test.ts`), а расклеить сборку по ролям через двери
 * постановки нельзя (`batch-pin-door.test.ts`). Но подмена жила НЕ в маршруте, а в двери
 * возврата, и её никто не искал: возврат сам стирал слово о роли.
 *
 * ЗАМЕРЕНО: `/api/enqueue` роль принимает ЯВНО — «редкий случай, когда владельцу нужен на
 * инлайн-задаче исследователь». Работа выходит на подтверждение, человек говорит «переделай» —
 * и `/api/return` ставит задачу заново ПОД ТЕМ ЖЕ НОМЕРОМ. Очередь при этом строку не
 * дополняет, а ПЕРЕЗАПИСЫВАЕТ целиком: всё, чего дверь не назвала, задача теряет молча. Дверь
 * называла конверт стадии, полосу, имя, слова и оценку — но не роль. Значит вторая попытка
 * работы, названной поимённо, приезжала БЕЗ имени, `roleWanted` отвечал «исполнитель»
 * (policy/worker-role.mjs), и работа шла под чужим описанием агента.
 *
 * ЭТО ТРЕТИЙ СЛУЧАЙ ОДНОГО И ТОГО ЖЕ ДЕФЕКТА ДВЕРИ. Первым молча терялся конверт стадии (и
 * работа возвращалась в чужой полосе), вторым — слова задачи (и работник второй попытки не
 * знал, чем она закрывается). Роль появилась позже обоих — вместе с правилом «работники и
 * агенты — это разное» — и в перечень двери не попала.
 *
 * ПОЧЕМУ ЭТО ИМЕННО ПОДМЕНА, А НЕ НЕДОСТАЧА. Роль — единственное слово, которым человек
 * называет исполнителя работы, и продукт обещает, что названного тихо не подменят: маршрут на
 * выключенного специалиста отвечает `role_unavailable`, а не ведёт работу кем попало
 * (`roleIsNamed`). Возврат, стирающий имя, это обещание обходил с другой стороны — не отказом,
 * а забывчивостью: жаловаться было не на что, потому что просьбы больше не существовало.
 *
 * ═══════════════════════ ЧТО ЗДЕСЬ ЗАКРЫТО ════════════════════════════════════════════════
 *   1. Дверь возврата: работа, названная поимённо, возвращается ТОЙ ЖЕ работой.
 *   2. Контроль: возврат безымянной работы роли не выдумывает — иначе «исполнитель по
 *      умолчанию» превратился бы в записанное на строке имя, и это была бы вторая правда.
 *   3. Дверь решения по сборке (`retry`): повторённый кусок остаётся куском той же роли. Иначе
 *      сборка, честно закреплённая за специалистом, расклеивалась бы на первом же повторе —
 *      ровно тем `role_mismatch`, который закрыт в `batch-pin-wire.test.ts`.
 *
 * ЧЕГО НЕ ДОКАЗЫВАЕТ: ни словаря ролей (`worker-role.test.ts`), ни выбора работника
 * (`batch-pin-wire.test.ts`), ни прочего тела этих дверей (`front-state.test.ts`).
 *
 * Ни один случай не поднимает процесс, не ходит в сеть и не пишет на диск: очередь в памяти,
 * дверь — функция, CAS — заглушка, запрос и ответ — заглушки.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createFrontServer } from '../src/front/server.mjs'
import { createMemoryQueue, BATCH_PARENT } from '../src/queue/adapter.mjs'
import { roleWanted } from '../src/policy/worker-role.mjs'

const TOKEN = 'c'.repeat(64)
const NOW = 1_700_000_000_000

function doorReq(url: string, body: unknown) {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function doorRes() {
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

/**
 * Мир одного случая: настоящие двери над настоящей очередью в памяти.
 *
 * `casExec` — заглушка ровно того места, где дверь возврата спорит за строку с другой дверью
 * (CAS в таблице попыток). Спор здесь не проверяется — он свой в `front-auth.test.ts`; тут
 * важно только, что дверь дошла до постановки задачи заново.
 */
function world() {
  const adapter = createMemoryQueue({ clock: () => NOW })
  const front = createFrontServer({
    config: { token: TOKEN, workers: [] },
    deps: {
      adapter,
      clock: () => NOW,
      taskTable: 'sma_task_attempts',
      casExec: async () => ({ rows: [{ id: 'won' }] }),
    },
  })
  return { adapter, front }
}

async function press(front: any, url: string, body: unknown) {
  const res = doorRes()
  await front.handle(doorReq(url, body), res)
  return res
}

/**
 * ЧТО СТОИТ В ОЧЕРЕДИ — В ТОМ ВИДЕ, В КАКОМ ЭТО УВИДИТ РАБОТНИК, и это здесь не мелочь:
 * маршрут спрашивает о роли ВЫДАННУЮ задачу, а не строку списка. Взятое доводится до конца,
 * иначе следующий вызов встанет — сборка отдаёт куски по одному.
 */
async function takeNext(adapter: any, workerId: string) {
  return adapter.claimNext(workerId, {})
}

describe('дверь возврата: работа, названная поимённо, возвращается той же работой', () => {
  it('роль переживает «переделай» — вторую попытку ведёт тот же, кого просил человек', async () => {
    const { adapter, front } = world()

    // Владелец назвал исследователя у двери одиночной постановки — законный явный выбор.
    const put = await press(front, '/api/enqueue', { title: 'посмотреть рынок', lane: 'prod', role: 'ai-researcher' })
    expect(put.statusCode).toBe(200)
    const taskId = JSON.parse(put.body).id

    const first = await takeNext(adapter, 'sma-ai-researcher')
    expect(first.id).toBe(taskId)
    expect(roleWanted(first)).toBe('ai-researcher')

    // Работа сделана и ждёт слова; слово — «переделай».
    await adapter.complete(taskId, { receiptRef: 'reverify:ok', attemptToken: first.attemptToken })
    const back = await press(front, '/api/return', { taskId, note: 'не то, посмотри ещё раз' })
    expect(back.statusCode).toBe(200)

    // ТА ЖЕ РАБОТА, А НЕ ПОХОЖАЯ: тот же номер, следующая попытка — и ТА ЖЕ просьба о роли.
    const second = await takeNext(adapter, 'sma-ai-researcher')
    expect(second.id).toBe(taskId)
    expect(second.attempt).toBe(2)
    expect(second.role).toBe('ai-researcher')
    // Сказано ещё и смыслом, а не только полем: маршрут спрашивает роль именно так, и без
    // слова о ней ответом был бы «исполнитель» — то есть молчаливая подмена.
    expect(roleWanted(second)).toBe('ai-researcher')
  })

  it('контроль: возврат безымянной работы роли не выдумывает', async () => {
    // Обратная сторона того же шва. «Роли не назвали» и «назвали исполнителя» — РАЗНЫЕ факты
    // (roleIsNamed), и от различия зависит, чем машина отвечает на выключенного работника.
    // Дверь, дописывающая имя от себя, стёрла бы это различие так же молча, как раньше стирала
    // саму просьбу.
    const { adapter, front } = world()

    const put = await press(front, '/api/enqueue', { title: 'обычная работа', lane: 'prod' })
    const taskId = JSON.parse(put.body).id

    const first = await takeNext(adapter, 'sma-executor')
    await adapter.complete(taskId, { receiptRef: 'reverify:ok', attemptToken: first.attemptToken })
    expect((await press(front, '/api/return', { taskId, note: 'переделай' })).statusCode).toBe(200)

    const second = await takeNext(adapter, 'sma-executor')
    expect(second.id).toBe(taskId)
    expect(second.role ?? null).toBeNull()
    expect(roleWanted(second)).toBe('executor')
  })
})

describe('дверь решения по сборке: повторённый кусок остаётся куском той же роли', () => {
  /**
   * Сборка, у которой роль названа на каждом куске, за специалистом держится честно — это
   * закреплено проводом в `batch-pin-wire.test.ts`. Повтор, теряющий роль, расклеил бы её на
   * первом же куске: `poolFor` увидел бы `role_mismatch` и отдал кусок исполнителю. Дверь
   * «повторить» стоит ровно на этом стыке, и здесь она за него отвечает.
   */
  it('«повторить» возвращает кусок с его ролью, а не огрызок без неё', async () => {
    const { adapter, front } = world()

    // Сборку с ролями сегодня ставит не дверь батча (роли она не несёт), а очередь напрямую —
    // это тот же состав, который `poolFor` считает честно закреплённым за специалистом.
    for (const n of [1, 2]) {
      await adapter.enqueue({
        id: `B-1-${n}`,
        source: 'roster',
        title: `кусок ${n}`,
        lane: 'prod',
        batchId: 'B-1',
        role: 'ai-researcher',
      })
    }
    await adapter.enqueue({
      id: 'B-1',
      source: 'roster',
      title: 'постановка',
      lane: 'prod',
      batchId: 'B-1',
      data: { batch: BATCH_PARENT, requestedAt: NOW },
    })

    const piece = await takeNext(adapter, 'sma-ai-researcher')
    expect(piece.id).toBe('B-1-1')
    await adapter.fail('B-1-1', 'agent_error', { attemptToken: piece.attemptToken })

    const decided = await press(front, '/api/batch/decide', { batchId: 'B-1', decision: 'retry', itemId: 'B-1-1' })
    expect(decided.statusCode).toBe(200)

    const again = await takeNext(adapter, 'sma-ai-researcher')
    expect(again.id).toBe('B-1-1')
    expect(again.batchId).toBe('B-1') // родство сборки дверь несла и раньше
    expect(again.role).toBe('ai-researcher') // роль — не несла, и сборка на этом расклеивалась
    expect(roleWanted(again)).toBe('ai-researcher')
  })
})
