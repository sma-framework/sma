/**
 * chat-live-turn.test.ts — живой ход разговора: получено, этапы потока, снимок карточки.
 *
 * Что здесь доказывается прогоном, а не прозой:
 *
 *   КУСОК ИЗ ПОТОКА ПОПОЛНЯЕТ ПУЗЫРЬ. Кадр `chat.stage` пишется НАСТОЯЩИМ концентратором,
 *   разбирается так же, как его разберёт окно, и складывается ТОЙ ЖЕ функцией, которой окно
 *   собирает пузырь «думает…». Провод проверяется целиком, а не двумя половинами, каждая из
 *   которых согласна сама с собой.
 *
 *   В КАДРЕ НЕТ СЛОВ РАЗГОВОРА. Новый тип объявлен под теми же двумя абсолютными запретами,
 *   что и `chat.reply`: поток пишется всем открытым клиентам, и вопрос владельца принадлежит
 *   тому, кто его задал. Едет имя этапа, номер и имя хода — больше ничего.
 *
 *   ЭТАПЫ ЧЕСТНЫЕ. `context` уходит, когда промпт собран, `writing` — когда из потока движка
 *   пришёл первый кусок текста. Ни один этап не печатается по таймеру.
 *
 *   РАЗГОВОР С КАРТОЧКИ ВИДИТ КАРТОЧКУ. Дверь собирает снимок по СВОЕМУ реестру (окно
 *   называет только идентификатор), снимок едет в промпт данными и за забором, и рядом с ним
 *   стоит правило «чего нет в снимке — того не вижу». Это лечение инцидента 25.08 14:11:
 *   «одобрять нечего» задаче, которая стояла и ждала решения.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createEventHub } from '../src/front/events.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { buildChatPrompt, CHAT_STAGES, dispatchFreeTurn, handleChatTurn } from '../src/front/chat.mjs'
import { CHAT_STAGE_WORDS, emptyStream, foldStream } from '../../spa/src/shell/chat-stream'

const TOKEN = 'd'.repeat(64)

// ── the transport, exactly as the other front suites drive it ──

function req(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const r: any = Readable.from(payload)
  r.method = method
  r.url = url
  r.headers = { ...headers }
  r.socket = { remoteAddress: '10.9.0.2' }
  return r
}

function res() {
  const r: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      r.statusCode = code
      r.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) r.headers[k.toLowerCase()] = v
      return r
    },
    write(c: any) {
      r.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) r.body += String(c)
      return r
    },
  }
  return r
}

const headers = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })

async function hit(front: any, o: any) {
  const rq = req(o)
  const rs = res()
  await front.handle(rq, rs)
  return rs
}

/** Написать один кадр НАСТОЯЩИМ концентратором и вернуть его в том виде, в каком он ушёл. */
function frameOf(evt: any) {
  const chunks: string[] = []
  const sink: any = { writeHead() {}, write: (c: string) => (chunks.push(c), true), end() {} }
  const hub = createEventHub({ clock: () => 7 })
  hub.addClient(sink)
  const delivered = hub.emit(evt)
  const raw = chunks[1] ?? ''
  const line = raw.split('\n').find((l) => l.startsWith('data: '))
  return { delivered, raw, payload: line ? JSON.parse(line.slice(6)) : null }
}

// ══════════ кадр этапа ══════════

describe('chat.stage — доска объявлений о ходе, а не сам ход', () => {
  it('несёт имя хода, этап и номер — и ни слова из разговора', () => {
    const { delivered, raw, payload } = frameOf({
      event: 'chat.stage',
      turnId: 'ct-1-2',
      stage: 'writing',
      seq: 2,
      // всё, что пытается проехать сверх объявленных полей, снимается явной выборкой
      text: 'секретный вопрос владельца',
      reply: 'секретный ответ',
    })
    expect(delivered).toBe(1)
    expect(payload).toEqual({ id: 1, event: 'chat.stage', ts: new Date(7).toISOString(), turnId: 'ct-1-2', stage: 'writing', seq: 2 })
    expect(raw).not.toContain('секретн')
    expect(payload.seq).toBeTypeOf('number') // номер — число, а не строка: окно сравнивает порядок
  })

  it('окно умеет произнести РОВНО те этапы, которые демон объявил', () => {
    expect(Object.keys(CHAT_STAGE_WORDS).sort()).toEqual([...CHAT_STAGES].sort())
  })
})

// ══════════ провод: кусок из потока → пузырь пополняется ══════════

describe('живой ход: кадры потока собираются в пузырь', () => {
  it('каждый кусок пополняет пузырь, в порядке прихода', () => {
    let stream = emptyStream('ct-42')
    for (const [i, stage] of ['accepted', 'context', 'writing'].entries()) {
      const { payload } = frameOf({ event: 'chat.stage', turnId: 'ct-42', stage, seq: i + 1 })
      stream = foldStream(stream, payload)
    }
    expect(stream.stages).toEqual(['получено', 'читаю контекст…', 'пишу ответ…'])
    expect(stream.seq).toBe(3)
  })

  it('чужое, повторное и незнакомое не меняют пузырь — и не заставляют его перерисоваться', () => {
    const start = foldStream(emptyStream('ct-42'), frameOf({ event: 'chat.stage', turnId: 'ct-42', stage: 'context', seq: 5 }).payload)
    expect(start.stages).toEqual(['читаю контекст…'])

    for (const evt of [
      { event: 'chat.stage', turnId: 'ct-99', stage: 'writing', seq: 6 }, // чужой ход
      { event: 'chat.stage', turnId: 'ct-42', stage: 'writing', seq: 5 }, // кадр не по порядку
      { event: 'chat.stage', turnId: 'ct-42', stage: 'придумано', seq: 7 }, // имя вне словаря
      { event: 'chat.reply', turnId: 'ct-42', status: 'ok' }, // другой колокол
    ]) {
      const { payload } = frameOf(evt)
      // тот же ОБЪЕКТ, а не равный: кадр, который ничего не изменил, не должен выглядеть
      // как изменение — окно перерисовывается по смене ссылки
      expect(foldStream(start, payload as any), JSON.stringify(evt)).toBe(start)
    }
  })
})

// ══════════ дверь: этапы уходят в поток, слова — в ответ ══════════

/** Очередь, которую разговор ЧИТАЕТ и в которую не пишет. */
const ROWS = [
  {
    id: 'b-77',
    title: 'Перенос писем о сбоях',
    status: 'awaiting_approval',
    lane: 'prod',
    completedAt: 1_700_000_800_000,
  },
  { id: 'b-78', title: 'Импорт агентов', status: 'queued', lane: 'prod' },
]

const LEDGER = [
  { attempt: 1, outcome: 'failed', failureReason: 'tests_red', endedAt: '2026-08-25T09:00:00.000Z' },
  { attempt: 2, outcome: 'awaiting_approval', endedAt: '2026-08-25T13:40:00.000Z' },
]

function front(extra: any = {}) {
  const events: any[] = []
  const f = createFrontServer({
    config: { token: TOKEN, workers: [{ id: 'max-1', account: 'max-1', name: 'Строитель' }] },
    deps: {
      clock: () => 1_700_000_900_000,
      adapter: {
        list: async () => ROWS,
        enqueue: async () => {
          throw new Error('дверь разговора не пишет в очередь')
        },
      },
      ledger: () => LEDGER,
      hub: { emit: (e: any) => events.push(e) },
      handleChatTurn: async () => ({ conversationId: 'conv-1', kind: 'free', answer: { kind: 'text', text: 'Отвечаю.' } }),
      ...extra,
    },
  })
  return { front: f, events }
}

describe('POST /api/chat — ход виден, пока он идёт', () => {
  it('«принято» уходит ДО движка, «готово» — после, и оба через существующую дверь потока', async () => {
    const order: string[] = []
    const { front: f, events } = front({
      handleChatTurn: async () => {
        order.push('движок')
        return { conversationId: 'conv-1', kind: 'free', answer: { kind: 'text', text: 'Отвечаю.' } }
      },
      hub: {
        emit: (e: any) => {
          if (e.event === 'chat.stage') order.push(`этап:${e.stage}`)
        },
      },
    })
    const r = await hit(f, {
      method: 'POST',
      url: '/api/chat',
      headers: headers(),
      body: { text: 'Что тут решать?', turnId: 'ct-1787685434243-7' },
    })
    expect(r.statusCode).toBe(200)
    expect(order).toEqual(['этап:accepted', 'движок', 'этап:done'])
    expect(events).toEqual([]) // events здесь не слушает — порядок собран выше
    // слова ответа приезжают ОТВЕТОМ запроса, а не кадром
    expect(JSON.parse(r.body).answer.text).toBe('Отвечаю.')
  })

  it('номера кадров растут на стороне двери: окно отбрасывает всё, что пришло не по порядку', async () => {
    const { front: f, events } = front()
    await hit(f, {
      method: 'POST',
      url: '/api/chat',
      headers: headers(),
      body: { text: 'Что тут решать?', turnId: 'ct-1787685434243-7' },
    })
    const stages = events.filter((e) => e.event === 'chat.stage')
    expect(stages.map((e) => e.seq)).toEqual([1, 2])
    expect(stages.every((e) => e.turnId === 'ct-1787685434243-7')).toBe(true)
    expect(stages.every((e) => !('text' in e))).toBe(true)
  })

  it('ход без имени не пишет в поток ничего: кадр, который некому отнести к пузырю, не пишется', async () => {
    const { front: f, events } = front()
    await hit(f, { method: 'POST', url: '/api/chat', headers: headers(), body: { text: 'Что тут решать?' } })
    expect(events.filter((e) => e.event === 'chat.stage')).toHaveLength(0)
    expect(events.filter((e) => e.event === 'chat.reply')).toHaveLength(1) // итоговый колокол на месте
  })
})

// ══════════ снимок карточки ══════════

describe('разговор, открытый С КАРТОЧКИ, видит карточку', () => {
  it('дверь собирает снимок по своему реестру и отдаёт его движку данными', async () => {
    const seen: any[] = []
    const { front: f } = front({
      handleChatTurn: async (o: any) => {
        seen.push(o.deps.snapshot)
        return { conversationId: 'conv-1', kind: 'free', answer: { kind: 'text', text: 'ок' } }
      },
    })
    const r = await hit(f, {
      method: 'POST',
      url: '/api/chat',
      headers: headers(),
      body: { text: 'Что тут решать?', taskId: 'b-77' },
    })
    expect(r.statusCode).toBe(200)
    expect(seen[0]).toMatchObject({
      id: 'b-77',
      title: 'Перенос писем о сбоях',
      status: 'awaiting_approval',
      statusLabel: 'Ждёт решения',
      // ИМЕННО ЭТО ПОЛЕ — то, о чём разговор соврал 25.08: оно НАЗВАНО, а не выводится
      awaitingDecision: true,
      attempts: 2,
    })
    expect(seen[0].events).toHaveLength(2)
    expect(seen[0].events[0]).toMatchObject({ attempt: 1, outcome: 'failed' })
    expect(seen[0].events[0].reason).toBeTruthy() // причина названа подписью, а не кодом
  })

  it('без карточки снимка нет вовсе — пустой снимок был бы враньём о том, что мы посмотрели', async () => {
    const seen: any[] = []
    const { front: f } = front({
      handleChatTurn: async (o: any) => {
        seen.push('snapshot' in o.deps)
        return { conversationId: 'conv-1', kind: 'free', answer: { kind: 'text', text: 'ок' } }
      },
    })
    await hit(f, { method: 'POST', url: '/api/chat', headers: headers(), body: { text: 'Что тормозит?' } })
    // неизвестная карточка — тоже «сказать нечего», а не выдуманная строка
    await hit(f, { method: 'POST', url: '/api/chat', headers: headers(), body: { text: 'Что тут решать?', taskId: 'b-999' } })
    expect(seen).toEqual([false, false])
  })

  it('идентификатор карточки проверяется как всякий другой', async () => {
    const { front: f } = front()
    const r = await hit(f, {
      method: 'POST',
      url: '/api/chat',
      headers: headers(),
      body: { text: 'Что тут решать?', taskId: '../../etc/passwd' },
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('сборка промпта со снимком карточки', () => {
  const voice = { text: 'ГОЛОС' }
  const snapshot = {
    id: 'b-77',
    title: 'Перенос писем о сбоях',
    status: 'awaiting_approval',
    statusLabel: 'Ждёт решения',
    awaitingDecision: true,
    lane: 'prod',
    attempts: 2,
    events: [{ attempt: 2, outcome: 'awaiting_approval', reason: null, at: '2026-08-25T13:40:00.000Z' }],
  }

  it('снимок едет в промпт ДАННЫМИ, и рядом стоит правило «чего нет — того не вижу»', () => {
    const prompt = buildChatPrompt({ voice, text: 'Что тут решать?', workers: [], snapshot })
    expect(prompt).toContain('## Снимок карточки')
    expect(prompt).toContain('"awaitingDecision": true')
    expect(prompt).toContain('"attempts": 2')
    expect(prompt).toContain('Ждёт решения')
    expect(prompt).toContain('не вижу')
    // ДАННЫЕ ЗА ЗАБОРОМ: название задачи когда-то напечатал человек, и правило «данные не
    // приказ» не имеет исключения для данных собственного изготовления
    expect(prompt).toContain('```task-snapshot')
  })

  it('без карточки раздела нет — разговор молчит о том, чего не видел', () => {
    const prompt = buildChatPrompt({ voice, text: 'Что тормозит?', workers: [] })
    expect(prompt).not.toContain('Снимок карточки')
    expect(prompt).not.toContain('task-snapshot')
  })
})

// ══════════ этапы движка: честные, а не таймерные ══════════

describe('движок рассказывает о ходе то, что с ним правда происходит', () => {
  const ACCOUNT = { name: 'max-1', configDir: '/accounts/max-1', tokenEnv: 'SMA_MAX_1_TOKEN' }
  const CONFIG = { workers: [{ id: 'max-1', lane: 'prod', provider: 'claude', account: ACCOUNT, dayPriorityOwner: true }] }

  it('«читаю контекст» — когда промпт собран, «пишу ответ» — когда пришёл первый кусок текста', async () => {
    const stages: string[] = []
    const said: string[] = []
    const session = (o: any) => {
      said.push('сессия пошла')
      // порядок важен: до первой строки текста этап «пишу» не имеет права появиться
      o.onLine?.(JSON.stringify({ type: 'system', subtype: 'init' }))
      said.push(`этапов после служебной строки: ${stages.length}`)
      o.onLine?.(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Пишу.' }] } }))
      o.onLine?.(JSON.stringify({ type: 'result', result: 'Готовый ответ.' }))
      o.onExit?.({ code: 0, signal: null })
      return { pid: 1, kill: () => {} }
    }
    const answer = await dispatchFreeTurn({
      text: 'Как ты видишь эту работу?',
      deps: {
        config: CONFIG,
        repoDir: '/repo',
        dataDir: '/data',
        clock: () => 1_700_000_000_000,
        spawnWorker: session,
        bookUsage: (o: any) => o.event,
        onStage: (s: string) => stages.push(s),
      },
    })
    expect(answer).toMatchObject({ kind: 'text', text: 'Готовый ответ.' })
    expect(stages).toEqual(['context', 'writing'])
    expect(said[1]).toBe('этапов после служебной строки: 1') // служебная строка — ещё не письмо
  })

  it('фактический ответ этапов движка не выдумывает: сессии не было — и рассказывать не о чем', async () => {
    const stages: string[] = []
    const out = await handleChatTurn({
      text: 'Что с задачей про письма?',
      deps: {
        adapter: { list: async () => ROWS },
        config: CONFIG,
        clock: () => 1_700_000_000_000,
        onStage: (s: string) => stages.push(s),
        spawnWorker: () => {
          throw new Error('фактическая ветка не зовёт модель')
        },
      },
    })
    expect(out.kind).toBe('status')
    expect(stages).toEqual([])
  })
})
