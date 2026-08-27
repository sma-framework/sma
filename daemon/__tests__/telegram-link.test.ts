/**
 * СВЯЗЬ С TELEGRAM, ШАГ ПЕРВЫЙ — и три вещи, которые решаются именно здесь.
 *
 * 1. БЕЗ ТОКЕНА ЦИКЛА НЕТ ВОВСЕ. Проверяется не значение флага, а ОТСУТСТВИЕ объекта: боевая
 *    фабрика демона собирается на конфиге без `telegram.botToken`, и `park.telegram` обязан
 *    быть null — а подставной `fetch`, поставленный на время файла, обязан остаться нетронутым.
 *    Флаг можно вычислить правильно и всё равно завести таймер; отсутствие видно только так.
 *
 * 2. ТОКЕН НЕ ВЫХОДИТ ИЗ МОДУЛЯ НИ В КАКОМ ВИДЕ. Адрес Bot API несёт учётные данные В ПУТИ,
 *    поэтому обычной аккуратности мало: сообщение упавшего транспорта цитирует адрес целиком.
 *    Здесь вызов ломается нарочно — тремя разными способами — и проверяются СЛОВА: ни целого
 *    токена, ни его секретной половины, а на месте пути стоит `bot[REDACTED]`.
 *
 * 3. ЧУЖОЙ ЧАТ НЕ РОЖДАЕТ ДЕЙСТВИЙ. Весь путь проигран на подставном транспорте: настоящий
 *    api.telegram.org в этом файле не трогается ни разу (за этим следит подмена globalThis.fetch,
 *    которая падает, если кто-то до него всё же дотянулся).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDaemon } from '../src/main.mjs'
import {
  createTelegramClient,
  redactBotToken,
  telegramChatId,
  telegramConfigured,
  TelegramApiError,
  TelegramTokenMissingError,
} from '../src/telegram/client.mjs'
import { createTelegramBridge, LINK_REPLY, STRANGER_REPLY, NON_TEXT_REPLY } from '../src/telegram/poll.mjs'

/** Похож на настоящий: числовой id бота, двоеточие, секрет. */
const BOT_TOKEN = '7654321:AAH-fake-secret-value-for-tests-only'
const SECRET_HALF = BOT_TOKEN.slice(BOT_TOKEN.indexOf(':') + 1)
const OWNER_CHAT = 424242
const STRANGER_CHAT = 999001

/** Ни одна строка, уезжающая наружу, не смеет содержать ни того, ни другого. */
function expectNoSecret(text: string) {
  expect(text).not.toContain(BOT_TOKEN)
  expect(text).not.toContain(SECRET_HALF)
}

const okAnswer = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })

/**
 * Подставной транспорт: очередь пачек обновлений для getUpdates, «доставлено» на sendMessage,
 * и запись КАЖДОГО вызова — на неё опирается проверка «чужой чат не родил ничего сверх отказа».
 */
function transport({ batches = [] as any[][], failWith }: { batches?: any[][]; failWith?: Error } = {}) {
  const calls: Array<{ method: string; payload: any }> = []
  const queue = [...batches]
  const fetchImpl = async (url: string, init: any) => {
    const method = String(url).split('/').pop() as string
    calls.push({ method, payload: init && init.body ? JSON.parse(String(init.body)) : {} })
    if (failWith) throw failWith
    if (method === 'getUpdates') return okAnswer(queue.length ? queue.shift() : [])
    return okAnswer({ message_id: calls.length })
  }
  return {
    fetchImpl,
    calls,
    sent: () => calls.filter((c) => c.method === 'sendMessage'),
  }
}

/** Одно текстовое сообщение из чата. */
const textUpdate = (id: number, chatId: number, text: string) => ({
  update_id: id,
  message: { message_id: id, chat: { id: chatId }, text },
})

// ══════════════════════ 1 · КЛИЕНТ: ТОКЕН, ЕГО ЧТЕНИЕ И ЕГО МОЛЧАНИЕ ══════════════════════

describe('клиент Bot API — токен берётся в момент вызова и не выходит наружу', () => {
  it('читает токен ИЗ КОНФИГА на каждом вызове, а не запоминает его при сборке', async () => {
    const config: any = { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT } }
    const t = transport()
    const client = createTelegramClient({ config, fetchImpl: t.fetchImpl })

    await client.sendMessage({ chatId: OWNER_CHAT, text: 'раз' })
    // Владелец поменял бота в файле конфига — следующий же вызов идёт с новым токеном.
    config.telegram.botToken = '111:BBB-another-secret-value'
    await client.sendMessage({ chatId: OWNER_CHAT, text: 'два' })
    // …а потом убрал его вовсе: вызова не происходит вообще, это отказ, а не запрос.
    delete config.telegram.botToken
    await expect(client.sendMessage({ chatId: OWNER_CHAT, text: 'три' })).rejects.toBeInstanceOf(
      TelegramTokenMissingError,
    )

    expect(t.calls.length).toBe(2)
  })

  it('упавший транспорт: в словах ошибки нет ни токена, ни его половины — на месте пути bot[REDACTED]', async () => {
    // Ровно та строка, которую пишет настоящий fetch: адрес целиком, с учёткой в пути.
    const boom = new Error(`request to https://api.telegram.org/bot${BOT_TOKEN}/getUpdates failed: ECONNRESET`)
    const t = transport({ failWith: boom })
    const client = createTelegramClient({ config: { telegram: { botToken: BOT_TOKEN } }, fetchImpl: t.fetchImpl })

    const err = await client.getUpdates({ timeout: 0 }).then(
      () => null,
      (e: any) => e,
    )
    expect(err).toBeInstanceOf(TelegramApiError)
    expectNoSecret(String(err.message))
    expectNoSecret(String(err.stack ?? ''))
    expect(err.message).toContain('bot[REDACTED]')
  })

  it('HTTP-отказ Bot API: описание чистится так же, и статус называется', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: `Unauthorized for /bot${BOT_TOKEN}/sendMessage` }),
    })
    const client = createTelegramClient({ config: { telegram: { botToken: BOT_TOKEN } }, fetchImpl })

    const err = await client.sendMessage({ chatId: OWNER_CHAT, text: 'п' }).then(
      () => null,
      (e: any) => e,
    )
    expect(err).toBeInstanceOf(TelegramApiError)
    expectNoSecret(String(err.message))
    expect(err.message).toContain('401')
    expect(err.message).toContain('bot[REDACTED]')
  })

  it('ответ с ok:false — тоже отказ, и тоже без учётных данных в словах', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, description: `chat not found (bot${BOT_TOKEN})` }),
    })
    const client = createTelegramClient({ config: { telegram: { botToken: BOT_TOKEN } }, fetchImpl })

    const err = await client.sendMessage({ chatId: 1, text: 'п' }).then(
      () => null,
      (e: any) => e,
    )
    expectNoSecret(String(err.message))
  })

  it('маскировка держится и на чужом токене — она про ФОРМУ пути, а не про то, что знает процесс', () => {
    const alien = 'https://api.telegram.org/bot55555:ZZZ-somebody-elses-token/getMe'
    expect(redactBotToken(alien, null)).toBe('https://api.telegram.org/bot[REDACTED]/getMe')
    // …и повторная чистка ничего не наслаивает
    expect(redactBotToken(redactBotToken(alien, null), null)).toBe('https://api.telegram.org/bot[REDACTED]/getMe')
  })

  it('«подключено» имеет одно определение, и id чата сравнивается строкой', () => {
    expect(telegramConfigured({})).toBe(false)
    expect(telegramConfigured({ telegram: { chatId: OWNER_CHAT } })).toBe(false)
    expect(telegramConfigured({ telegram: { botToken: '   ' } })).toBe(false)
    expect(telegramConfigured({ telegram: { botToken: BOT_TOKEN } })).toBe(true)
    expect(telegramChatId({ telegram: { chatId: OWNER_CHAT } })).toBe(String(OWNER_CHAT))
    expect(telegramChatId({ telegram: { chatId: `${OWNER_CHAT}` } })).toBe(String(OWNER_CHAT))
    expect(telegramChatId({ telegram: {} })).toBe(null)
  })
})

// ══════════════════════ 2 · ЦИКЛ: ПОЛНЫЙ ПУТЬ НА ПОДСТАВНОМ ТРАНСПОРТЕ ══════════════════════

describe('опросный цикл, шаг 1 — кто получает ответ, а кто ничего', () => {
  const config = { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT } }

  it('текст из спаренного чата получает ответ-заглушку про связь', async () => {
    const t = transport({ batches: [[textUpdate(10, OWNER_CHAT, 'привет')]] })
    const bridge = createTelegramBridge({ config, fetchImpl: t.fetchImpl })!
    expect(bridge).not.toBe(null)

    const actions = await bridge.pollOnce()

    expect(actions).toEqual([{ action: 'answered' }])
    expect(t.sent()).toEqual([{ method: 'sendMessage', payload: { chat_id: OWNER_CHAT, text: LINK_REPLY } }])
    // офсет ведётся: следующий опрос просит только то, что после прочитанного
    expect(bridge.offset()).toBe(11)
  })

  it('чужой чат получает вежливый отказ и НЕ РОЖДАЕТ НИЧЕГО БОЛЬШЕ', async () => {
    const t = transport({ batches: [[textUpdate(20, STRANGER_CHAT, '/start')]] })
    const bridge = createTelegramBridge({ config, fetchImpl: t.fetchImpl })!

    const actions = await bridge.pollOnce()

    expect(actions).toEqual([{ action: 'refused' }])
    // Ровно один исходящий вызов, и он — та самая фраза. Ни второго сообщения, ни ответа
    // владельцу, ни какого-либо ещё обращения к Bot API.
    expect(t.sent()).toEqual([{ method: 'sendMessage', payload: { chat_id: STRANGER_CHAT, text: STRANGER_REPLY } }])
    expect(t.calls.map((c) => c.method)).toEqual(['getUpdates', 'sendMessage'])
  })

  it('чужой чат остаётся чужим и с фотографией: проверка пары идёт ДО разбора содержимого', async () => {
    const t = transport({
      batches: [[{ update_id: 21, message: { message_id: 21, chat: { id: STRANGER_CHAT }, photo: [{ file_id: 'x' }] } }]],
    })
    const bridge = createTelegramBridge({ config, fetchImpl: t.fetchImpl })!

    expect(await bridge.pollOnce()).toEqual([{ action: 'refused' }])
    expect(t.sent()).toEqual([{ method: 'sendMessage', payload: { chat_id: STRANGER_CHAT, text: STRANGER_REPLY } }])
  })

  it('голос, фото и документ от владельца получают «пока только текст»', async () => {
    for (const message of [
      { message_id: 30, chat: { id: OWNER_CHAT }, voice: { file_id: 'v' } },
      { message_id: 31, chat: { id: OWNER_CHAT }, photo: [{ file_id: 'p' }] },
      { message_id: 32, chat: { id: OWNER_CHAT }, document: { file_id: 'd' } },
    ]) {
      const t = transport({ batches: [[{ update_id: message.message_id, message }]] })
      const bridge = createTelegramBridge({ config, fetchImpl: t.fetchImpl })!

      expect(await bridge.pollOnce()).toEqual([{ action: 'non-text' }])
      expect(t.sent()).toEqual([{ method: 'sendMessage', payload: { chat_id: OWNER_CHAT, text: NON_TEXT_REPLY } }])
      expect(NON_TEXT_REPLY).toContain('только текст')
    }
  })

  it('без спаренного чата в конфиге владельца нет — никто не получает ничего, кроме отказа', async () => {
    const t = transport({ batches: [[textUpdate(40, OWNER_CHAT, 'привет')]] })
    const bridge = createTelegramBridge({ config: { telegram: { botToken: BOT_TOKEN } }, fetchImpl: t.fetchImpl })!

    expect(await bridge.pollOnce()).toEqual([{ action: 'refused' }])
    expect(t.sent()).toEqual([{ method: 'sendMessage', payload: { chat_id: OWNER_CHAT, text: STRANGER_REPLY } }])
  })

  it('офсет едет от пачки к пачке — прочитанное не спрашивается второй раз', async () => {
    const t = transport({
      batches: [
        [textUpdate(100, OWNER_CHAT, 'раз'), textUpdate(101, OWNER_CHAT, 'два')],
        [textUpdate(102, OWNER_CHAT, 'три')],
      ],
    })
    const bridge = createTelegramBridge({ config, fetchImpl: t.fetchImpl })!

    await bridge.pollOnce()
    await bridge.pollOnce()

    const polls = t.calls.filter((c) => c.method === 'getUpdates')
    expect(polls[0].payload.offset).toBe(undefined) // первый опрос ещё ничего не прочитал
    expect(polls[0].payload.timeout).toBeGreaterThan(0) // это длинный опрос, а не частый частокол
    expect(polls[1].payload.offset).toBe(102)
    expect(bridge.offset()).toBe(103)
  })

  it('обновление, которое шаг 1 не читает, не получает ответа и не двигает ничего лишнего', async () => {
    const t = transport({ batches: [[{ update_id: 50, callback_query: { id: 'c1' } }]] })
    const bridge = createTelegramBridge({ config, fetchImpl: t.fetchImpl })!

    expect(await bridge.pollOnce()).toEqual([{ action: 'ignored' }])
    expect(t.sent()).toEqual([])
    expect(bridge.offset()).toBe(51) // прочитано — значит, больше не спрашиваем
  })

  it('сломанный вызов пишет строку в лог — и в НЕЙ тоже нет ни токена, ни его половины', async () => {
    const boom = new Error(`request to https://api.telegram.org/bot${BOT_TOKEN}/getUpdates failed`)
    const t = transport({ failWith: boom })
    const lines: string[] = []
    // Отдых после отказа — это то место, где цикл ждёт; здесь он вместо ожидания
    // останавливается, поэтому весь прогон занимает один круг и ни одного таймера.
    let bridge: any = null
    bridge = createTelegramBridge({
      config,
      fetchImpl: t.fetchImpl,
      log: (line: string) => lines.push(line),
      sleep: async () => {
        bridge.stop()
      },
    })!

    await bridge.start()

    expect(bridge.running()).toBe(false)
    const complaint = lines.find((l) => l.includes('опрос не прошёл'))
    expect(complaint, 'цикл промолчал об отказе — тогда некому и утечь, но и диагностики нет').toBeTruthy()
    for (const line of lines) expectNoSecret(line)
    expect(String(complaint)).toContain('bot[REDACTED]')
  })

  it('отказ доставки ответа не роняет цикл — жалоба в лог, работа продолжается', async () => {
    const calls: string[] = []
    const fetchImpl = async (url: string) => {
      const method = String(url).split('/').pop() as string
      calls.push(method)
      if (method === 'sendMessage') throw new Error(`send failed for /bot${BOT_TOKEN}/sendMessage`)
      return okAnswer(calls.length === 1 ? [textUpdate(60, OWNER_CHAT, 'привет')] : [])
    }
    const lines: string[] = []
    const bridge = createTelegramBridge({ config, fetchImpl, log: (l: string) => lines.push(l) })!

    await expect(bridge.pollOnce()).resolves.toEqual([{ action: 'answered' }])
    for (const line of lines) expectNoSecret(line)
    expect(lines.some((l) => l.includes('не удалось ответить'))).toBe(true)
    // Прочитанное всё равно прочитано: повтор ответа на то же сообщение — это вечный круг.
    expect(bridge.offset()).toBe(61)
  })
})

// ══════════════════════ 3 · ПРОВОД: БЕЗ ТОКЕНА ЦИКЛА НЕ СУЩЕСТВУЕТ ══════════════════════

describe('провод демона — цикл появляется ТОЛЬКО от токена в конфиге', () => {
  let tmpRoot: string
  const savedEnv: Record<string, string | undefined> = {}
  let realFetch: any
  let fetchCalls = 0

  const configPathFor = (name: string, telegram?: object) => {
    const dir = join(tmpRoot, name)
    mkdirSync(join(dir, 'repo'), { recursive: true })
    const path = join(dir, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({
        queueUrl: 'postgres://127.0.0.1:1/sma_none', // закрытый порт: демон только собирается
        bind: '127.0.0.1',
        port: 7998,
        token: 'd'.repeat(64),
        repoDir: join(dir, 'repo'),
        dataDir: join(dir, 'data'),
        ledgerDir: join(dir, 'ledger'),
        projects: [{ id: 'p1', name: 'p1' }],
        activeProject: 'p1',
        workers: [],
        ...(telegram ? { telegram } : {}),
      }),
      'utf8',
    )
    return path
  }

  const build = (name: string, telegram?: object) => {
    process.env.SMA_DAEMON_CONFIG = configPathFor(name, telegram)
    return createDaemon()
  }

  const park = (p: any) => {
    try {
      if (p && p.hub && typeof p.hub.close === 'function') p.hub.close()
      if (p && p.daemon && typeof p.daemon.stop === 'function') p.daemon.stop()
      if (p && p.telegram) p.telegram.stop()
    } catch {
      /* best-effort */
    }
  }

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sma-telegram-'))
    for (const key of ['SMA_DAEMON_CONFIG', 'SMA_DAEMON_MCP']) savedEnv[key] = process.env[key]
    process.env.SMA_DAEMON_MCP = join(tmpRoot, 'absent-mcp.json')
    // НАСТОЯЩИЙ api.telegram.org в этом файле не трогается: если кто-то дотянулся до сети,
    // это видно счётчиком, а сам вызов падает, а не уезжает наружу.
    realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('в этом тесте сеть не трогают')
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

  it('конфиг без telegram: цикла НЕТ как объекта, и ни одного сетевого вызова', () => {
    const p = build('plain')
    try {
      // Не «флаг посчитан выключенным», а «объекта не существует»: заводить таймер нечему.
      expect(p.telegram).toBe(null)
      expect(fetchCalls).toBe(0)
    } finally {
      park(p)
    }
  })

  it('конфиг с одним лишь chatId — по-прежнему ничего: связь начинается с токена', () => {
    const p = build('chat-only', { chatId: OWNER_CHAT })
    try {
      expect(p.telegram).toBe(null)
      expect(fetchCalls).toBe(0)
    } finally {
      park(p)
    }
  })

  it('конфиг с токеном: цикл собран, но сам по себе молчит, пока демон не запущен', () => {
    const p = build('linked', { botToken: BOT_TOKEN, chatId: OWNER_CHAT })
    try {
      expect(p.telegram).not.toBe(null)
      expect(typeof p.telegram.start).toBe('function')
      expect(typeof p.telegram.stop).toBe('function')
      expect(p.telegram.running()).toBe(false)
      expect(fetchCalls).toBe(0) // сборка — это не запуск
    } finally {
      park(p)
    }
  })

  it('фабрика цикла — единственный владелец решения «подключено ли»', () => {
    expect(createTelegramBridge({ config: {} })).toBe(null)
    expect(createTelegramBridge({ config: { telegram: {} } })).toBe(null)
    expect(createTelegramBridge({ config: { telegram: { chatId: OWNER_CHAT } } })).toBe(null)
    expect(createTelegramBridge({ config: { telegram: { botToken: BOT_TOKEN } } })).not.toBe(null)
  })
})
