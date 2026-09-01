/**
 * ЧЕМ ПРАВИЛО «ОДНА СБОРКА — ОДИН РАБОТНИК» ЗАПЕРТО НА САМОМ ДЕЛЕ — НАБОРАМИ КЛЮЧЕЙ ДВУХ ДВЕРЕЙ.
 *
 * ═══════════════════════ ОТКУДА ЭТОТ ФАЙЛ ══════════════════════════════════════════════════
 * Правило держится тем, что кусок сборки достаётся работнику предыдущего куска (`poolFor`), а
 * РОЛЬ этот выбор перебивает: кусок без слова о роли просит ИСПОЛНИТЕЛЯ, и сборка, закреплённая
 * за специалистом, на нём расклеивается — это доказано проводом в `batch-pin-wire.test.ts`.
 * Значит вопрос «а достижима ли расклейка по ролям через продукт» решается не маршрутом, а тем,
 * может ли хоть одна дверь положить в ОДНУ сборку куски с РАЗНЫМИ ролями.
 *
 * Дверей, у которых это вообще могло бы получиться, ровно две, и они запирают с разных сторон:
 *
 *   • `POST /api/batch` — единственная, кто пишет `batchId` на строки, — роли НЕ принимает.
 *     Значит все куски одной сборки просят одно и то же. Закреплено в `front-state.test.ts`
 *     («дверь батча роли НЕ несёт»).
 *   • `POST /api/enqueue` — роль принимает ЯВНО (владельцу иногда нужен исследователь на
 *     одиночной работе), — зато не принимает `batchId`. Значит названную роль некуда приписать.
 *     ЭТА ПОЛОВИНА НЕ БЫЛА ЗАКРЕПЛЕНА НИЧЕМ, и она здесь.
 *
 * ═══════════════════════ ПОЧЕМУ ЭТО СТОИТ ЗАКРЫВАТЬ ═══════════════════════════════════════
 * Замок стоит на НАБОРЕ РАЗРЕШЁННЫХ КЛЮЧЕЙ — там, где его никто не ищет. Правка, добавившая
 * `batchId` в набор двери одиночной постановки, впустила бы кусок с ролью в готовую сборку:
 * следующий тик увидел бы роль, отбросил бы закрепление и увёз кусок другому работнику. Это и
 * есть тихая расклейка сборки по разным счетам — ровно то, от чего правило и стоит. Сегодня ни
 * один прогон бы на такой правке не покраснел.
 *
 * ═══════════════════════ ЧЕГО ЭТОТ ФАЙЛ НЕ ДОКАЗЫВАЕТ ════════════════════════════════════
 * Ни выбора работника (`batch-pin-wire.test.ts`), ни словаря ролей (`worker-role.test.ts`), ни
 * прочей проверки тела этих дверей (`front-state.test.ts`). Здесь — ровно достижимость
 * расклейки по ролям через двери постановки.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ ФАЙЛОМ, А НЕ РЯДОМ С СОСЕДНЕЙ ПОЛОВИНОЙ: обе двери проверяются в файлах,
 * которые в момент этой правки правили другие сессии того же рабочего дерева. Писать в них
 * значило бы гонку, а не помощь; ссылки в обе стороны названы выше, чтобы половины не
 * разъехались молча.
 *
 * Случаи не поднимают процесс, не ходят в сеть и не пишут на диск: очередь в памяти, дверь —
 * функция, запрос и ответ — заглушки.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createFrontServer } from '../src/front/server.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'

const TOKEN = 'b'.repeat(64)
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

describe('дверь одиночной постановки роль берёт, а чужую сборку — нет', () => {
  /** Мир одного случая: настоящая дверь над настоящей очередью в памяти. */
  function world() {
    const adapter = createMemoryQueue({ clock: () => NOW })
    const front = createFrontServer({
      config: { token: TOKEN, workers: [] },
      deps: { adapter, clock: () => NOW },
    })
    return { adapter, front }
  }

  async function press(front: any, url: string, body: unknown) {
    const res = doorRes()
    await front.handle(doorReq(url, body), res)
    return res
  }

  /**
   * ВСЁ, ЧТО В ОЧЕРЕДИ ЛЕЖИТ, — В ТОМ ВИДЕ, В КАКОМ ЭТО УВИДИТ РАБОТНИК.
   *
   * Читается ВЫДАЧЕЙ, а не списком, и это здесь не мелочь: `list()` отдаёт СОКРАЩЁННУЮ форму
   * строки (окно перечитывает её по нескольку раз в секунду) и `role` в неё не кладёт вовсе.
   * Проверка роли по списку была бы зелёной всегда — в том числе на двери, которая роли
   * действительно пишет, — то есть проверяла бы форму чтения, а не то, что записано.
   *
   * Каждый взятый кусок ДОВОДИТСЯ ДО КОНЦА, иначе обход встанет на первом же: сборка отдаёт
   * куски по одному — «один работник, по одному куску за раз» — и следующий ждёт предыдущего.
   */
  async function drain(adapter: any) {
    const out: any[] = []
    for (let n = 0; n < 20; n += 1) {
      const claimed = await adapter.claimNext(`w${n + 1}`, {})
      if (!claimed) break
      out.push(claimed)
      await adapter.complete(claimed.id, { receiptRef: 'reverify:ok', attemptToken: claimed.attemptToken })
    }
    return out
  }

  it('роль назвать можно, приписать её к готовой сборке — нельзя, и отказ приходит ДО записи', async () => {
    const { adapter, front } = world()

    const made = await press(front, '/api/batch', { title: 'разгрести', items: ['первое', 'второе'] })
    expect(made.statusCode).toBe(200)
    const batchId = JSON.parse(made.body).id

    // Роль на ОДИНОЧНОЙ работе — законный выбор владельца, и дверь его принимает.
    const single = await press(front, '/api/enqueue', { title: 'к исследователю', lane: 'prod', role: 'ai-researcher' })
    expect(single.statusCode).toBe(200)

    // Тот же выбор, приписанный к ЧУЖОЙ сборке, — отказ, и он приходит до всякой записи.
    const smuggled = await press(front, '/api/enqueue', {
      title: 'третий кусок',
      lane: 'prod',
      role: 'ai-researcher',
      batchId,
    })
    expect(smuggled.statusCode).toBe(400)

    // ОТКАЗ НАЗЫВАЕТСЯ СЛОВАМИ, и в них названо ровно отказанное поле. Молчаливое отбрасывание
    // непонятого ключа выглядело бы для человека как принятая просьба — и кусок, которого он
    // ждал в сборке, просто не появился бы там, без единого слова о том, почему.
    expect(smuggled.body).toContain('batchId')

    // ОТКАЗ НИЧЕГО НЕ ПОЛОЖИЛ: сборка осталась той же длины, что вышла из своей двери.
    const rows = await adapter.list({})
    expect(rows.filter((r: any) => r.batchId === batchId)).toHaveLength(3)

    // ПОЛОЖИТЕЛЬНАЯ ПОЛОВИНА, которая переживёт смену набора ключей, потому что говорит о том,
    // ЧТО ЗАПИСАНО, а не о валидации: роль, названную у двери, несёт ровно одна строка — и она
    // не принадлежит ничьей сборке.
    const claimed = await drain(adapter)
    const named = claimed.filter((c) => c.role === 'ai-researcher')
    expect(named).toHaveLength(1)
    expect(named[0].batchId ?? null).toBeNull()

    // И с другой стороны того же шва: ни один кусок сборки роли не назвал, значит все просят
    // одно и то же и закрепление держится от первого куска до последнего.
    const pieces = claimed.filter((c) => c.batchId === batchId && c.id !== batchId)
    expect(pieces.length).toBeGreaterThan(0)
    for (const p of pieces) expect(p.role ?? null).toBeNull()
  })

  it('сборка, поставленная дверью батча, роли не несёт ни на одной строке', async () => {
    // Вторая сторона того же утверждения, взятая с этой стороны шва: если бы дверь батча
    // когда-нибудь начала писать роль, куски одной сборки перестали бы просить одно и то же —
    // и закрепление расклеилось бы на первом же куске с расходящейся ролью.
    const { adapter, front } = world()

    const made = await press(front, '/api/batch', { title: 'разгрести', items: ['первое', 'второе', 'третье'] })
    expect(made.statusCode).toBe(200)

    expect(await adapter.list({})).toHaveLength(4) // три куска и строка запроса

    const claimed = await drain(adapter)
    expect(claimed.length).toBeGreaterThanOrEqual(3)
    for (const c of claimed) expect(c.role ?? null).toBeNull()
  })
})
