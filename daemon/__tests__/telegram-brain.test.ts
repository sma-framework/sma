/**
 * ТЕЛЕГРАМ, ШАГ ТРЕТИЙ: БОТ И ОКНО ХОДЯТ В ОДИН МОЗГ — и это проверяется вызовом, а не текстом.
 *
 * Слово владельца: «мозг должен быть идентичным — один в один как бы я писал в фронте». Такое
 * свойство нельзя проверить по ответу: два разных ума на простом вопросе отвечают одинаково и
 * расходятся ровно там, где это дорого («сколько ждёт одобрения?»). Поэтому здесь проверяется
 * СБОРКА: с какими сотрудниками входящее сообщение доходит до `handleChatTurn` — тот же снимок
 * доски, та же стенограмма, тот же движок, — и проверяется она на БОЕВОМ проводе демона, а не
 * на пересказе провода в тесте.
 *
 * Четыре вещи, ради которых файл существует:
 *   1. ПРОВОД. Настоящая фабрика демона, настоящая дверь фронта со своими сотрудниками-шпионами.
 *      Сообщение из спаренного чата обязано вызвать `handleChatTurn` со снимком доски внутри.
 *   2. ОБЩАЯ КНИГА. Ход из телеграма читается тем же `readHistory`, каким его читает экран
 *      «Разговор», и второй ход продолжает ту же нить.
 *   3. ДЛИННЫЙ ОТВЕТ. Режется по границам абзацев под предел 4096 и уходит по порядку, целиком.
 *   4. ЧУЖОЙ НЕ ДОХОДИТ ДО МОЗГА. Ни одного вызова движка от чужого сообщения.
 *
 * Сеть — только подставным транспортом: настоящий api.telegram.org в этом файле не трогается
 * ни разу, и за этим следит подмена globalThis.fetch, которая падает при любом обращении.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDaemon } from '../src/main.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { handleChatTurn, readHistory } from '../src/front/chat.mjs'
import {
  createTelegramBridge,
  splitForTelegram,
  answerToText,
  DRAFT_NOTE,
  DECISION_NOTE,
  TURN_FAILED_REPLY,
  TELEGRAM_TEXT_LIMIT,
  TYPING_INTERVAL_MS,
  STRANGER_REPLY,
} from '../src/telegram/poll.mjs'

const BOT_TOKEN = '7654321:AAH-fake-secret-value-for-tests-only'
const OWNER_CHAT = 424242
const STRANGER_CHAT = 999001

const okAnswer = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })

/** Подставной транспорт: он же протокол — что именно ушло в Bot API и в каком порядке. */
function transport({ batches = [] as any[][] }: { batches?: any[][] } = {}) {
  const calls: Array<{ method: string; payload: any }> = []
  const queue = [...batches]
  const fetchImpl = async (url: string, init: any) => {
    const method = String(url).split('/').pop() as string
    calls.push({ method, payload: init && init.body ? JSON.parse(String(init.body)) : {} })
    if (method === 'getUpdates') return okAnswer(queue.length ? queue.shift() : [])
    return okAnswer({ message_id: calls.length })
  }
  return {
    fetchImpl,
    calls,
    sent: () => calls.filter((c) => c.method === 'sendMessage'),
    typing: () => calls.filter((c) => c.method === 'sendChatAction'),
  }
}

const textUpdate = (id: number, chatId: number, text: string) => ({
  update_id: id,
  message: { message_id: id, chat: { id: chatId }, text },
})

const config = { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT } }

// ═════════════════ 1 · ПРОВОД: ТОТ ЖЕ ДВИЖОК И ТЕ ЖЕ СОТРУДНИКИ ═════════════════════

describe('провод демона — сообщение из бота идёт в мозг двери чата', () => {
  let tmpRoot: string
  const savedEnv: Record<string, string | undefined> = {}
  let realFetch: any
  let netCalls = 0
  let sent: Array<{ method: string; payload: any }>

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sma-tg-brain-'))
    for (const key of ['SMA_DAEMON_CONFIG', 'SMA_DAEMON_MCP']) savedEnv[key] = process.env[key]
    process.env.SMA_DAEMON_MCP = join(tmpRoot, 'absent-mcp.json')
    realFetch = globalThis.fetch
    // Настоящая сеть недоступна: любое обращение к api.telegram.org видно счётчиком и падает.
    globalThis.fetch = (async (url: string, init: any) => {
      netCalls += 1
      const method = String(url).split('/').pop() as string
      sent.push({ method, payload: init && init.body ? JSON.parse(String(init.body)) : {} })
      return okAnswer({ message_id: netCalls })
    }) as any
  })

  afterAll(() => {
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  beforeEach(() => {
    sent = []
  })

  it('входящий текст вызывает handleChatTurn со снимком доски — тем же, что собирает дверь чата', async () => {
    const dir = join(tmpRoot, 'wire')
    mkdirSync(join(dir, 'repo'), { recursive: true })
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        queueUrl: 'postgres://127.0.0.1:1/sma_none', // закрытый порт: демон только собирается
        bind: '127.0.0.1',
        port: 7997,
        token: 'd'.repeat(64),
        repoDir: join(dir, 'repo'),
        dataDir: join(dir, 'data'),
        ledgerDir: join(dir, 'ledger'),
        projects: [{ id: 'p1', name: 'p1' }],
        activeProject: 'p1',
        workers: [],
        telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT },
      }),
      'utf8',
    )
    process.env.SMA_DAEMON_CONFIG = configPath

    // ДВЕРЬ НАСТОЯЩАЯ, сотрудники — шпионы. Мост получает не их, а то, что фабрика фронта
    // отдаёт обратно как свой набор: если корень свяжет мост с чем-то другим, это будет видно.
    const seen: any[] = []
    const front = createFrontServer({
      config: { token: 'd'.repeat(64) },
      deps: {
        clock: () => 1_700_000_000_000,
        adapter: { list: async () => [] },
        chatDir: join(dir, 'chat'),
        deriveState: async () => ({
          activeProject: 'p1',
          projects: [{ id: 'p1', name: 'p1', taskCounts: { queued: 2 } }],
          kpis: { queued: 2, awaitingApproval: 3, workersBusy: 0, workersTotal: 1 },
          awaiting: [{ id: 'T-1', title: 'ждёт решения', status: 'awaiting_approval' }],
          queue: [],
        }),
        handleChatTurn: async (args: any) => {
          seen.push(args)
          return { conversationId: 'conv-1', kind: 'status', answer: { kind: 'text', text: 'три задачи ждут решения' } }
        },
      },
    })

    const park = createDaemon({ front })
    try {
      expect(park.telegram).not.toBe(null)

      await park.telegram.handleUpdate(textUpdate(1, OWNER_CHAT, 'сколько ждёт одобрения?'))

      expect(seen.length, 'мозг не позвали вовсе — тогда у бота свой ум, а не общий').toBe(1)
      expect(seen[0].text).toBe('сколько ждёт одобрения?')
      // ТЕ ЖЕ СОТРУДНИКИ: снимок доски (собранный дверью, а не мостом), движок стенограммы,
      // очередь. Проверяется ВЫЗОВ — что именно доехало до мозга, а не что он посчитал.
      const passed = seen[0].deps
      expect(passed.board).toEqual({
        activeProject: 'p1',
        projects: [{ id: 'p1', name: 'p1', taskCounts: { queued: 2 } }],
        kpis: { queued: 2, awaitingApproval: 3, workersBusy: 0, workersTotal: 1 },
        awaiting: [
          { id: 'T-1', title: 'ждёт решения', project: null, status: 'awaiting_approval', statusLabel: 'Ждёт решения' },
        ],
        queue: [],
      })
      expect(passed.historyDir).toBe(join(dir, 'chat')) // та же книга, что читает окно
      expect(typeof passed.adapter.list).toBe('function')
      expect(passed.config.telegram.chatId).toBe(OWNER_CHAT)

      // …и ответ уехал в чат владельца обычным текстом.
      const messages = sent.filter((c) => c.method === 'sendMessage')
      expect(messages).toEqual([{ method: 'sendMessage', payload: { chat_id: OWNER_CHAT, text: 'три задачи ждут решения' } }])
    } finally {
      try {
        park.telegram?.stop()
        park.daemon?.stop()
        park.hub?.close?.()
      } catch {
        /* best-effort */
      }
    }
  })
})

// ═════════════════ 2 · ОБЩАЯ СТЕНОГРАММА И НИТЬ БЕСЕДЫ ═════════════════════════════

describe('стенограмма у бота и окна одна, и нить продолжается', () => {
  let chatDir: string

  beforeAll(() => {
    chatDir = mkdtempSync(join(tmpdir(), 'sma-tg-book-'))
  })
  afterAll(() => {
    try {
      rmSync(chatDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('вопрос из телеграма и ответ на него читаются тем же readHistory, и второй ход — та же беседа', async () => {
    // НАСТОЯЩИЙ движок разговора: словарная ветка «что с задачей» — ни сессии, ни сети.
    const rows = [{ id: 'T-7', title: 'мост телеграма', status: 'awaiting_approval', attempt: 1 }]
    const chatTurn = ({ text, conversationId }: any) =>
      handleChatTurn({
        text,
        conversationId,
        deps: { adapter: { list: async () => rows }, historyDir: chatDir, config: {} },
      })

    const t = transport()
    const bridge = createTelegramBridge({ config, chatTurn, fetchImpl: t.fetchImpl })!

    await bridge.handleUpdate(textUpdate(1, OWNER_CHAT, 'что с задачей T-7?'))
    const thread = bridge.conversationId()
    expect(thread, 'нить не завелась — каждый ход был бы отдельной беседой').toBeTruthy()

    await bridge.handleUpdate(textUpdate(2, OWNER_CHAT, 'что с задачей T-7 сейчас?'))
    expect(bridge.conversationId()).toBe(thread) // тот же ход нити, а не вторая беседа рядом

    // ЧИТАЕТ ЭКРАН «РАЗГОВОР» — тем же читателем и по тому же id беседы.
    const book = readHistory({ dir: chatDir, conversationId: thread as string })
    expect(book.map((turn: any) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(book[0].text).toBe('что с задачей T-7?')
    expect(book[1].taskRef.id).toBe('T-7') // карточка задачи легла в книгу так же, как из окна
    expect(book[2].text).toBe('что с задачей T-7 сейчас?')
    // …и то, что прочитало окно, — это ровно то, что ушло в телеграм.
    expect(t.sent().map((c) => c.payload.text)).toEqual([book[1].text, book[3].text])
  })

  it('черновик задачи кнопкой не становится: бот называет задачу и говорит, где она заводится', async () => {
    const chatTurn = ({ text, conversationId }: any) =>
      handleChatTurn({ text, conversationId, deps: { historyDir: chatDir, config: {} } })
    const t = transport()
    const bridge = createTelegramBridge({ config, chatTurn, fetchImpl: t.fetchImpl })!

    await bridge.handleUpdate(textUpdate(3, OWNER_CHAT, 'Исследуй, как устроен retrieval в памяти'))

    const [message] = t.sent()
    expect(message.payload.text).toContain(DRAFT_NOTE)
    expect(message.payload.text).toContain('retrieval')
    // Ни разметки, ни кнопок: в исходящем вызове ровно два поля.
    expect(Object.keys(message.payload).sort()).toEqual(['chat_id', 'text'])
  })
})

// ═════════════════ 3 · ЧТО УХОДИТ В ЧАТ: ПРЕДЕЛ, ПОРЯДОК, КНОПКИ ═══════════════════

describe('ответ в чат — обычный текст, порезанный по абзацам', () => {
  it('длинный ответ уходит несколькими сообщениями по порядку и ничего не теряет', async () => {
    // Двенадцать абзацев по ~500 символов: заведомо больше предела, и все границы — абзацные.
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Абзац ${i + 1}. ${'слово '.repeat(80)}`.trim())
    const long = paragraphs.join('\n\n')
    expect(long.length).toBeGreaterThan(TELEGRAM_TEXT_LIMIT)

    const t = transport()
    const bridge = createTelegramBridge({
      config,
      chatTurn: async () => ({ conversationId: 'conv-9', answer: { kind: 'text', text: long } }),
      fetchImpl: t.fetchImpl,
    })!

    await bridge.handleUpdate(textUpdate(1, OWNER_CHAT, 'расскажи подробно'))

    const chunks = t.sent().map((c) => c.payload.text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
    // Порядок — это и есть текст: склеенные по границам абзацев куски дают исходный ответ.
    expect(chunks.join('\n\n')).toBe(long)
    // Каждый кусок начинается с целого абзаца, то есть резали по границе, а не по буквам.
    for (const chunk of chunks) expect(chunk.startsWith('Абзац ')).toBe(true)
  })

  it('резка сама по себе: абзац, потом строка, и только потом буква', () => {
    expect(splitForTelegram('коротко')).toEqual(['коротко'])
    expect(splitForTelegram('')).toEqual([])

    const a = 'a'.repeat(30)
    const b = 'b'.repeat(30)
    expect(splitForTelegram(`${a}\n\n${b}`, 40)).toEqual([a, b])

    const line1 = 'c'.repeat(30)
    const line2 = 'd'.repeat(30)
    expect(splitForTelegram(`${line1}\n${line2}`, 40)).toEqual([line1, line2])

    // Абзац без единой границы внутри: последнее средство — ровный разрез по пределу.
    const solid = 'e'.repeat(25)
    expect(splitForTelegram(solid, 10)).toEqual(['eeeeeeeeee', 'eeeeeeeeee', 'eeeee'])
  })

  it('предложение решения не становится кнопкой — оно называет задачу и отсылает в окно', () => {
    const text = answerToText({
      kind: 'decision',
      text: 'задача готова к решению',
      decision: { taskId: 'T-3', title: 'мост телеграма' },
    })
    expect(text).toContain('задача готова к решению')
    expect(text).toContain(DECISION_NOTE)
    expect(text).toContain('мост телеграма')
  })

  it('пока ход идёт — «печатает», и не чаще раза в четыре секунды', async () => {
    expect(TYPING_INTERVAL_MS).toBe(4000)
    const t = transport()
    const bridge = createTelegramBridge({
      config,
      // Ход держится дольше одного круга событий — но заведомо меньше интервала.
      chatTurn: async () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ conversationId: 'conv-2', answer: { kind: 'text', text: 'готово' } }), 120),
        ),
      fetchImpl: t.fetchImpl,
    })!

    await bridge.handleUpdate(textUpdate(1, OWNER_CHAT, 'подумай'))

    expect(t.typing()).toEqual([{ method: 'sendChatAction', payload: { chat_id: OWNER_CHAT, action: 'typing' } }])
    // Сначала «печатает», потом ответ — иначе статус приходит к уже готовому тексту.
    expect(t.calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage'])
  })

  it('упавший ход не роняет цикл и не молчит в чат', async () => {
    const t = transport()
    const lines: string[] = []
    const bridge = createTelegramBridge({
      config,
      chatTurn: async () => {
        throw new Error('движок отказал')
      },
      fetchImpl: t.fetchImpl,
      log: (l: string) => lines.push(l),
    })!

    expect(await bridge.handleUpdate(textUpdate(1, OWNER_CHAT, 'привет'))).toEqual({ action: 'failed' })
    expect(t.sent()).toEqual([{ method: 'sendMessage', payload: { chat_id: OWNER_CHAT, text: TURN_FAILED_REPLY } }])
    expect(lines.some((l) => l.includes('ход разговора не прошёл'))).toBe(true)
  })
})

// ═════════════════ 4 · ЧУЖОЙ ЧАТ ДО МОЗГА НЕ ДОХОДИТ ══════════════════════════════

describe('чужое сообщение не рождает ни одного вызова движка', () => {
  it('чужой чат: отказ одной фразой, мозг не позван, ход не записан', async () => {
    let calls = 0
    const t = transport()
    const bridge = createTelegramBridge({
      config,
      chatTurn: async () => {
        calls += 1
        return { conversationId: 'conv-3', answer: { kind: 'text', text: 'не должно случиться' } }
      },
      fetchImpl: t.fetchImpl,
    })!

    expect(await bridge.handleUpdate(textUpdate(1, STRANGER_CHAT, 'сколько ждёт одобрения?'))).toEqual({
      action: 'refused',
    })

    expect(calls, 'чужой добрался до движка — это и есть утечка всей доски').toBe(0)
    expect(bridge.conversationId()).toBe(null) // и нити владельца он не тронул
    expect(t.sent()).toEqual([{ method: 'sendMessage', payload: { chat_id: STRANGER_CHAT, text: STRANGER_REPLY } }])
    expect(t.typing()).toEqual([]) // чужому даже «печатает» не показывают
  })
})
