/**
 * СЛОВО СОГЛАСИЯ СТАВИТ ЗАДАЧУ — И ОДИНАКОВО В ОКНЕ И В БОТЕ.
 *
 * Приказ владельца: разговор договаривается словами и САМ ставит задачу, когда человек
 * согласился; на телефоне кнопок нет вовсе, поэтому «да» там — единственный способ сказать
 * «ставь», и в окне то же слово обязано работать так же. Двери должны быть одной дверью.
 *
 * Пять вещей, ради которых файл существует, и все они проверяются ВЫЗОВОМ, а не текстом:
 *
 *   1. СЛОВАРЬ СОГЛАСИЯ УЗОК. Согласие — это целое сообщение из слов согласия. «Да, но
 *      сначала посмотри расходы» согласием не является: то, что человек сказал вдобавок,
 *      движок не вправе отбросить, чтобы услышать «ставь».
 *
 *   2. ПРОВОД. «Да» доезжает до ПОСТАНОВКИ: проверяется вызов выданной двери с тем самым
 *      черновиком, а не намерение движка и не слова его ответа.
 *
 *   3. ОДИНАКОВОСТЬ ДВЕРЕЙ. Один и тот же обмен — «исследуй…», потом «да» — прогоняется
 *      ЧЕРЕЗ ОКНО (POST /api/chat на настоящем фронте) и ЧЕРЕЗ МОСТ ТЕЛЕГРАМА (настоящий
 *      мост, зовущий ту же сборку хода, что и корень демона). Очередь получает две
 *      одинаковые задачи, человек читает одну и ту же фразу.
 *
 *   4. ПРИЁМКА ИЗ БОТА НЕ ОТКРЫВАЕТСЯ. «Да» после предложения решения не принимает работу и
 *      не ставит задачу; у моста нет ни кнопок, ни глагола приёмки вовсе.
 *
 *   5. ВТОРОЕ «ДА» НЕ ЗАВОДИТ ВТОРУЮ КОПИЮ, а согласие в пустоту честно говорит, что
 *      соглашаться не с чем.
 *
 * Сеть здесь не трогается ни разу: телеграм ходит подставным транспортом, очередь —
 * подставным адаптером, который ЗАПИСЫВАЕТ поставленное, а не отказывает.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { describe, it, expect } from 'vitest'

import { createFrontServer, runChatTurn } from '../src/front/server.mjs'
import {
  appendTurn,
  classifyTurn,
  handleChatTurn,
  isConsent,
  taskPutText,
  CONSENT_NOTHING_TEXT,
  CONSENT_NO_DOOR_TEXT,
  CONSENT_STAGE_TEXT,
} from '../src/front/chat.mjs'
import { createTelegramBridge, answerToText, DRAFT_NOTE, DECISION_NOTE } from '../src/telegram/poll.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'sma-consent-'))

const FRONT_TOKEN = 'e'.repeat(64)
const BOT_TOKEN = '7654321:AAH-fake-secret-value-for-tests-only'
const OWNER_CHAT = 424242
const CLOCK = 1_700_000_900_000

const WORKERS = [{ id: 'max-1', account: 'max-1', name: 'Строитель', lane: 'prod' }]

/** Черновик, какой кладёт в книгу словарная ветка постановки. */
const DRAFT = { title: 'Переписать импорт агентов', lane: 'prod', mode: 'обычный' }

/** Беседа, в которой последним словом помощника был черновик, — то, с чем и соглашаются. */
function seedDraft(dir: string, conversationId: string, draft: any = DRAFT) {
  appendTurn({
    dir,
    turn: { conversationId, role: 'user', kind: 'task-prod', text: 'Поставь длинную задачу: переписать импорт агентов' },
  })
  appendTurn({
    dir,
    turn: { conversationId, role: 'assistant', kind: 'draft', text: 'Понял как длинную работу.', draft },
  })
}

/** Дверь постановки, выданная разговору: шпион, который ЗАПИСЫВАЕТ, что ему передали. */
function putSpy(id = 'R-put-1') {
  const calls: any[] = []
  return {
    calls,
    fn: async (draft: any) => {
      calls.push(draft)
      return { ok: true, id, title: draft && draft.title }
    },
  }
}

// ═════════════════ 1 · СЛОВАРЬ: ЧТО ЕСТЬ СОГЛАСИЕ, А ЧТО РАЗГОВОР ═══════════════════

describe('согласие — это слово человека, а не догадка движка', () => {
  it('целое сообщение из слов согласия читается как согласие', () => {
    for (const said of ['да', 'Да!', 'ок', 'Окей', 'давай', 'Давай, ставь', 'ага, поехали', 'хорошо, поставь задачу', 'Согласен', 'ладно, заводи']) {
      expect(isConsent(said), said).toBe(true)
    }
    expect(classifyTurn('да')).toBe('consent')
    expect(classifyTurn('Давай, ставь')).toBe('consent')
  })

  it('фраза, в которой сказано что-то ещё, согласием не является', () => {
    for (const said of [
      'да, но сначала посмотри расходы',
      'нет',
      'не надо',
      'Поставь задачу про импорт агентов',
      'Что съело ночной лимит?',
      '',
    ]) {
      expect(isConsent(said), said).toBe(false)
    }
    // …и ветки, которые отвечают на вопросы о доске, согласие у них не отняло
    expect(classifyTurn('Что съело ночной лимит?')).toBe('spend')
    expect(classifyTurn('Исследуй, как устроен поиск по корпусу')).toBe('task-research')
    expect(classifyTurn('Почему упала задача про значок тестов?')).toBe('fail-reason')
  })
})

// ═════════════════ 2 · ПРОВОД: СЛОВО ДОЕЗЖАЕТ ДО ПОСТАНОВКИ ═════════════════════════

describe('провод согласия: «да» зовёт дверь постановки с тем самым черновиком', () => {
  it('слово согласия ставит последний предложенный черновик — проверяется вызов', async () => {
    const dir = tmp()
    const put = putSpy('R-1700000900000')
    seedDraft(dir, 'conv-1')

    const res = await handleChatTurn({
      text: 'да, ставь',
      conversationId: 'conv-1',
      deps: { historyDir: dir, config: { workers: WORKERS }, putTask: put.fn, clock: () => CLOCK },
    })

    // ВЫЗОВ, а не намерение: дверь получила ровно тот черновик, который висел последним.
    expect(put.calls).toEqual([DRAFT])
    expect(res.kind).toBe('consent')
    expect(res.answer.kind).toBe('created')
    expect(res.answer.text).toBe(taskPutText(DRAFT.title))
    expect(res.answer.taskRef).toMatchObject({ id: 'R-1700000900000', title: DRAFT.title, status: 'queued' })
  })

  it('второе «да» подряд не заводит вторую копию — соглашаться уже не с чем', async () => {
    const dir = tmp()
    const put = putSpy()
    seedDraft(dir, 'conv-2')
    const deps = { historyDir: dir, config: { workers: WORKERS }, putTask: put.fn, clock: () => CLOCK }

    await handleChatTurn({ text: 'да', conversationId: 'conv-2', deps })
    const again = await handleChatTurn({ text: 'да', conversationId: 'conv-2', deps })

    expect(put.calls).toHaveLength(1) // ровно одна постановка на одно согласие
    expect(again.answer.text).toBe(CONSENT_NOTHING_TEXT)
  })

  it('согласие в пустоту ничего не ставит и говорит об этом', async () => {
    const dir = tmp()
    const put = putSpy()
    const res = await handleChatTurn({
      text: 'да',
      conversationId: 'conv-3',
      deps: { historyDir: dir, config: {}, putTask: put.fn },
    })
    expect(put.calls).toHaveLength(0)
    expect(res.answer.text).toBe(CONSENT_NOTHING_TEXT)
  })

  it('согласие на стадию фазы словом её не запускает — у стадии своя дверь', async () => {
    const dir = tmp()
    const put = putSpy()
    seedDraft(dir, 'conv-4', {
      title: 'Стадия «планирование» фазы 12',
      mode: 'обычный',
      data: { kind: 'stage', stage: 'plan', phase: '12' },
    })
    const res = await handleChatTurn({
      text: 'давай',
      conversationId: 'conv-4',
      deps: { historyDir: dir, config: {}, putTask: put.fn },
    })
    expect(put.calls).toHaveLength(0)
    expect(res.answer.text).toBe(CONSENT_STAGE_TEXT)
  })

  it('разговору без выданной двери постановка не мерещится', async () => {
    const dir = tmp()
    seedDraft(dir, 'conv-5')
    const res = await handleChatTurn({ text: 'ок', conversationId: 'conv-5', deps: { historyDir: dir, config: {} } })
    expect(res.answer.text).toBe(CONSENT_NO_DOOR_TEXT)
    expect(res.answer.error).toBe('no-put-door')
  })

  it('отказ двери — фраза человеку, а не поломка хода', async () => {
    const dir = tmp()
    seedDraft(dir, 'conv-6')
    const res = await handleChatTurn({
      text: 'да',
      conversationId: 'conv-6',
      deps: { historyDir: dir, config: {}, putTask: async () => ({ ok: false, reason: 'очередь не приняла задачу' }) },
    })
    expect(res.answer.kind).toBe('fact')
    expect(res.answer.text).toContain('очередь не приняла задачу')
  })
})

// ═════════════════ 3 · ОДИНАКОВОСТЬ ДВЕРЕЙ: ОКНО И ТЕЛЕГРАМ ═════════════════════════
//
// Один и тот же обмен, прогнанный дважды. Окно ходит настоящей дверью `POST /api/chat`; бот —
// настоящим мостом, которому выдана та же сборка хода, какой его связывает корень демона
// (`runChatTurn` с сотрудниками фронта). Совпадать обязаны обе половины исхода: что легло в
// очередь и что прочитал человек.

function chatReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body } = o
  const payload = body == null ? [] : [Buffer.from(JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
  req.socket = { remoteAddress: '10.9.0.1' }
  return req
}

function chatRes() {
  const res: any = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(code: number) {
      res.statusCode = code
      res.headersSent = true
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

async function post(front: any, body: any) {
  const res = chatRes()
  await front.handle(
    chatReq({
      method: 'POST',
      url: '/api/chat',
      headers: { authorization: `Bearer ${FRONT_TOKEN}`, 'content-type': 'application/json' },
      body,
    }),
    res,
  )
  return JSON.parse(res.body)
}

/** Очередь, которая ПРИНИМАЕТ: этот файл проверяет постановку, а не отказ от неё. */
function queueSpy() {
  const enqueued: any[] = []
  return {
    enqueued,
    adapter: {
      list: async () => [],
      enqueue: async (task: any) => {
        enqueued.push(task)
        return { id: task.id }
      },
    },
  }
}

const okAnswer = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })

/** Подставной транспорт телеграма: он же протокол — что и куда ушло. */
function transport() {
  const calls: Array<{ method: string; payload: any }> = []
  const fetchImpl = async (url: string, init: any) => {
    const method = String(url).split('/').pop() as string
    calls.push({ method, payload: init && init.body ? JSON.parse(String(init.body)) : {} })
    if (method === 'getUpdates') return okAnswer([])
    return okAnswer({ message_id: calls.length })
  }
  return { fetchImpl, calls, sent: () => calls.filter((c) => c.method === 'sendMessage') }
}

const textUpdate = (id: number, text: string) => ({
  update_id: id,
  message: { message_id: id, chat: { id: OWNER_CHAT }, text },
})

/** Фронт, собранный как его собирает корень демона — с настоящим движком разговора. */
function front(dir: string) {
  const q = queueSpy()
  const events: any[] = []
  // ОДИН объект конфига на дверь и на мост — ровно так их связывает корень демона.
  const config = {
    token: FRONT_TOKEN,
    workers: WORKERS,
    projects: [{ id: 'sma', name: 'sma' }],
    activeProject: 'sma',
    telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT },
  }
  const server = createFrontServer({
    config,
    deps: {
      clock: () => CLOCK,
      adapter: q.adapter,
      hub: { emit: (e: any) => events.push(e) },
      handleChatTurn,
      chatDir: dir,
    },
  })
  return { server, config, q, events }
}

describe('одинаковость дверей: одно слово, один исход — в окне и в телеграме', () => {
  const ASK = 'Исследуй, как устроен поиск по корпусу'

  it('через окно: «исследуй…» → черновик, «да» → задача в очереди', async () => {
    const dir = tmp()
    const { server, q, events } = front(dir)

    const drafted = await post(server, { text: ASK })
    expect(drafted.answer.kind).toBe('draft')
    expect(q.enqueued).toHaveLength(0) // черновик инертен, как и был

    const created = await post(server, { text: 'да', conversationId: drafted.conversationId })
    expect(created.kind).toBe('consent')
    expect(created.answer.kind).toBe('created')
    expect(q.enqueued).toHaveLength(1)
    expect(q.enqueued[0]).toMatchObject({ title: ASK, lane: 'research', source: 'roster', project: 'sma' })
    expect(created.answer.taskRef.id).toBe(q.enqueued[0].id)
    // …и колокол доски прозвонил ровно так же, как от кнопки
    expect(events.some((e) => e.event === 'task.queued' && e.taskId === q.enqueued[0].id)).toBe(true)
  })

  it('через мост телеграма — то же слово, тот же исход, и ни одной кнопки', async () => {
    const dir = tmp()
    const { server, config, q } = front(dir)
    const t = transport()
    // ТА ЖЕ СВЯЗКА, ЧТО В КОРНЕ ДЕМОНА: у моста одна способность — сборка хода фронта.
    const bridge = createTelegramBridge({
      config: { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT } },
      chatTurn: ({ text, conversationId }: any) =>
        runChatTurn({ config, deps: server.deps, text, conversationId }),
      fetchImpl: t.fetchImpl,
    })!

    await bridge.handleUpdate(textUpdate(1, ASK))
    expect(q.enqueued).toHaveLength(0)
    const offered = t.sent()[0].payload.text
    expect(offered).toContain(DRAFT_NOTE) // на телефоне черновик ЗОВЁТ слово, а не кнопку
    expect(DRAFT_NOTE).toContain('«да»')

    await bridge.handleUpdate(textUpdate(2, 'да'))

    expect(q.enqueued).toHaveLength(1)
    expect(q.enqueued[0]).toMatchObject({ title: ASK, lane: 'research', source: 'roster', project: 'sma' })
    const said = t.sent().map((c) => c.payload.text)
    expect(said[said.length - 1]).toBe(taskPutText(ASK))
    // ни разметки, ни кнопок: в исходящем вызове по-прежнему ровно два поля
    for (const call of t.sent()) expect(Object.keys(call.payload).sort()).toEqual(['chat_id', 'text'])
  })

  it('исход двух дверей совпадает буква в букву — и в очереди, и в словах человеку', async () => {
    const windowSide = front(tmp())
    const botSide = front(tmp())
    const t = transport()
    const bridge = createTelegramBridge({
      config: { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT } },
      chatTurn: ({ text, conversationId }: any) =>
        runChatTurn({ config: botSide.config, deps: botSide.server.deps, text, conversationId }),
      fetchImpl: t.fetchImpl,
    })!

    const drafted = await post(windowSide.server, { text: ASK })
    const created = await post(windowSide.server, { text: 'да', conversationId: drafted.conversationId })

    await bridge.handleUpdate(textUpdate(1, ASK))
    await bridge.handleUpdate(textUpdate(2, 'да'))

    // ОЧЕРЕДЬ: одна и та же задача, поле в поле (часы у обеих дверей одни, значит и номер).
    expect(botSide.q.enqueued).toEqual(windowSide.q.enqueued)
    // СЛОВА: то, что человек прочитал в окне, — это то, что он прочитал в телефоне.
    expect(t.sent().map((c) => c.payload.text).pop()).toBe(created.answer.text)
  })
})

// ═════════════════ 4 · ПРИЁМКА ИЗ БОТА НЕ ОТКРЫВАЕТСЯ ═══════════════════════════════

describe('постановка — да, приёмка — нет', () => {
  it('«да» после предложения решения ничего не принимает и ничего не ставит', async () => {
    const dir = tmp()
    const put = putSpy()
    appendTurn({ dir, turn: { conversationId: 'conv-d', role: 'user', text: 'что там с задачей?' } })
    appendTurn({
      dir,
      turn: {
        conversationId: 'conv-d',
        role: 'assistant',
        kind: 'decision',
        text: 'задача готова к решению',
        decision: { taskId: 'T-3', title: 'мост телеграма' },
      },
    })

    const res = await handleChatTurn({
      text: 'да',
      conversationId: 'conv-d',
      deps: { historyDir: dir, config: {}, putTask: put.fn },
    })

    expect(put.calls).toHaveLength(0)
    expect(res.answer.kind).toBe('fact')
    expect(res.answer.text).toBe(CONSENT_NOTHING_TEXT) // соглашаться было не с чем — решение решают рукой
  })

  it('у моста нет ни кнопок, ни глагола приёмки — предложение решения остаётся фразой', () => {
    const text = answerToText({
      kind: 'decision',
      text: 'задача готова к решению',
      decision: { taskId: 'T-3', title: 'мост телеграма' },
    })
    expect(text).toContain(DECISION_NOTE)
    expect(DECISION_NOTE).toContain('в окне')

    // Способность, которой в модуле нет, из него не утечёт: приёмка не называется ни разу.
    const src = readFileSync(new URL('../src/telegram/poll.mjs', import.meta.url), 'utf8')
    for (const verb of ['approve', 'reply_markup', 'inline_keyboard']) {
      expect(src.toLowerCase().includes(verb), verb).toBe(false)
    }
  })

  it('и сам движок разговора приёмки не знает — глагола в нём нет', () => {
    const src = readFileSync(new URL('../src/front/chat.mjs', import.meta.url), 'utf8')
    expect(src.includes('enqueue')).toBe(false) // очередь по-прежнему не его дверь
    expect(src.includes('approve')).toBe(false)
  })
})
