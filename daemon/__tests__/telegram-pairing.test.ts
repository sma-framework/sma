/**
 * СВЯЗЬ С TELEGRAM, ШАГ ВТОРОЙ — ПОДКЛЮЧЕНИЕ ИЗ ОКНА, И ТРИ ВЕЩИ, КОТОРЫЕ РЕШАЮТСЯ ЗДЕСЬ.
 *
 * Шаг первый подключал бота ПРАВКОЙ ФАЙЛА: человек шёл в `config.json` демона и вписывал туда
 * `telegram.botToken` и `telegram.chatId` — число, которое ещё надо было где-то раздобыть.
 * Владельцу этого хватало; тому, кто просто поставил SMA, — нет. Здесь направление
 * развёрнуто: окно принимает токен и выдаёт КОРОТКИЙ КОД, человек отправляет код своему же
 * боту в личку, и чат записывает себя сам. Файл не открывает никто.
 *
 * 1. ВЕСЬ ПУТЬ ПРОЙДЕН ЦЕЛИКОМ, А НЕ ПО КУСКАМ. Дверь — конфиг на диске — цикл — обратно
 *    дверь: токен сохраняется, код выдаётся, сообщение с кодом из чата сверяется, пара
 *    ложится в файл, и картина окна говорит «подключён», называя чат ИМЕНЕМ. Каждое звено
 *    этого пути по отдельности можно сделать правильно и всё равно не соединить: между
 *    «дверь записала токен» и «человек увидел подключение» три шва, и разорван может быть
 *    любой.
 *
 * 2. ТОКЕН УХОДИТ ВНУТРЬ И НЕ ВОЗВРАЩАЕТСЯ. Это единственная дверь продукта, в теле запроса
 *    к которой едет учётная запись, поэтому проверяются СЛОВА всего, что выходит наружу: ответ
 *    самой двери, картина `/api/harness`, отказ на кривом токене, логируемая форма конфига и
 *    строки лога цикла. Целого токена нет ни в одной из них — наружу выходит хвост из четырёх
 *    знаков, и только он.
 *
 * 3. КОД ОДНОРАЗОВЫЙ И СРОЧНЫЙ, И ОБА СВОЙСТВА ПРОВЕРЯЮТСЯ ОТКАЗОМ. Второй чат с тем же кодом
 *    получает обычный отказ незнакомцу; просроченный код — тот же отказ, и просрочка считается
 *    ДО сравнения букв, чтобы «всё-таки сработало» никогда не было свойством правильно
 *    набранных знаков.
 *
 * СЕТИ ЗДЕСЬ НЕТ. Весь Bot API — подставной транспорт; настоящий `fetch` подменён на время
 * файла и падает, если кто-то до него всё же дотянулся.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { createFrontServer, ROUTES, TELEGRAM_ACTIONS } from '../src/front/server.mjs'
import { readHarness } from '../src/front/harness.mjs'
import {
  applyTelegramConnect,
  applyTelegramDisconnect,
  applyTelegramPair,
  secretsView,
  InvalidTelegramLinkError,
} from '../src/config.mjs'
import { createTelegramBridge, PAIRED_REPLY, STRANGER_REPLY } from '../src/telegram/poll.mjs'
import {
  matchesPairingCode,
  mintPairing,
  telegramLinkView,
  codeFromMessage,
  normalizeCode,
  PAIRING_TTL_MS,
  PAIRING_CODE_LENGTH,
  PAIRING_ALPHABET,
} from '../src/telegram/pairing.mjs'

const TOKEN = 'f'.repeat(64)
/** Похож на настоящий: числовой id бота, двоеточие, секрет. */
const BOT_TOKEN = '7654321:AAH-fake-secret-value-for-tests-only'
const SECRET_HALF = BOT_TOKEN.slice(BOT_TOKEN.indexOf(':') + 1)
const TOKEN_TAIL = BOT_TOKEN.slice(-4)
const OWNER_CHAT = 424242
const OTHER_CHAT = 555001
const T0 = 1_800_000_000_000

/** Ни одна строка, уезжающая наружу или ложащаяся в лог, не смеет содержать ни того, ни другого. */
function expectNoSecret(text: string, where: string) {
  expect(text, `${where}: целый токен вышел наружу`).not.toContain(BOT_TOKEN)
  expect(text, `${where}: секретная половина токена вышла наружу`).not.toContain(SECRET_HALF)
}

// ── временный мир: настоящий файл конфига, никакого домашнего каталога человека ─────────────

const tmpDirs: string[] = []
function mkDir(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
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

let realFetch: any
let fetchCalls = 0
beforeAll(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('в этом тесте сеть не трогают')
  }) as any
})
afterAll(() => {
  globalThis.fetch = realFetch
})

// ── поддельные req/res ─────────────────────────────────────────────────────────────────────

function mkReq(url: string, body?: any) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : [])
  req.method = body === undefined ? 'GET' : 'POST'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '127.0.0.1' }
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
    end(chunk?: any) {
      if (chunk != null) res.body += String(chunk)
      return res
    },
  }
  return res
}

/**
 * Настоящий мир одной установки: конфиг лежит файлом, дверь собрана с НАСТОЯЩИМИ
 * применителями (подделать их — значит проверить подделку), а часы держит тест.
 *
 * `restarts` — счётчик перезапусков цикла. Без него «токен записан» и «бот слушает» —
 * два разных факта, и второй остаётся необеспеченным до перезапуска процесса, о котором
 * человеку никто не скажет.
 */
function world() {
  const root = mkDir('sma-tg-pair-')
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const configPath = join(root, 'config.json')
  const env = { SMA_DAEMON_CONFIG: configPath } as any

  let now = T0
  const config: any = { token: TOKEN, repoDir: repo }
  const restarts: number[] = []
  const logs: string[] = []

  const front = createFrontServer({
    config,
    deps: {
      env,
      launchDir: repo,
      repoDir: repo,
      clock: () => now,
      // НАСТОЯЩАЯ картина окна, а не подделка: «что видит человек» — половина этой работы.
      readHarness,
      applyTelegramConnect,
      applyTelegramDisconnect,
      telegramRestart: () => restarts.push(now),
    },
  })

  /** Тот же провод, что и в корне сборки: цикл узнаёт чат — применитель кладёт пару в файл. */
  const onPaired = ({ chatId, chatTitle }: any) => {
    const next = applyTelegramPair(config, { chatId, chatTitle }, { env, launchDir: repo })
    if (next && next.telegram) config.telegram = next.telegram
    return true
  }

  return {
    config,
    configPath,
    env,
    repo,
    restarts,
    logs,
    onPaired,
    at: () => now,
    advance: (ms: number) => {
      now += ms
    },
    onDisk: () => JSON.parse(readFileSync(configPath, 'utf8')),
    post: async (body: any) => {
      const res = mkRes()
      await front.handle(mkReq('/api/connection/telegram', body), res)
      return res
    },
    harness: async () => {
      const res = mkRes()
      await front.handle(mkReq('/api/harness'), res)
      return res
    },
  }
}

/** Подставной транспорт Bot API: очередь пачек для getUpdates, «доставлено» на sendMessage. */
function transport({ batches = [] as any[][] }: { batches?: any[][] } = {}) {
  const calls: Array<{ method: string; payload: any }> = []
  const queue = [...batches]
  const fetchImpl = async (url: string, init: any) => {
    const method = String(url).split('/').pop() as string
    calls.push({ method, payload: init && init.body ? JSON.parse(String(init.body)) : {} })
    if (method === 'getUpdates') {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: queue.length ? queue.shift() : [] }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) }
  }
  return { fetchImpl, calls, sent: () => calls.filter((c) => c.method === 'sendMessage') }
}

/** Одно сообщение из чата, с именем, каким его даёт Telegram. */
const msg = (id: number, chatId: number, text: string, chat: any = {}) => ({
  update_id: id,
  message: { message_id: id, chat: { id: chatId, ...chat }, text },
})

// ══════════════════ 1 · ВЕСЬ ПУТЬ: ТОКЕН → КОД → ЧАТ → «ПОДКЛЮЧЁН» ══════════════════

describe('подключение из окна — весь путь, от поля ввода до имени чата на экране', () => {
  it('токен, код, сообщение боту, пара в файле и состояние «подключён» — одним прогоном', async () => {
    const w = world()

    // ── шаг 1: человек вставил токен и нажал «Подключить» ──────────────────────────────
    const connected = await w.post({ action: 'connect', botToken: BOT_TOKEN })
    expect(connected.statusCode).toBe(200)
    const view = JSON.parse(connected.body).telegram
    expect(view.status).toBe('awaiting_code')
    expect(view.tokenTail).toBe(TOKEN_TAIL)
    expect(view.chat).toBe(null)
    // код читается человеком с экрана: две группы по четыре, и ни одного двойника (0/O, 1/I)
    expect(view.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    for (const ch of normalizeCode(view.code)) expect(PAIRING_ALPHABET).toContain(ch)
    expect(view.expiresAt).toBe(w.at() + PAIRING_TTL_MS)
    // …и цикл пересобран В ТОМ ЖЕ нажатии: иначе код улетел бы в чат, который никто не слушает
    expect(w.restarts.length, 'токен записан, а слушать его некому до перезапуска процесса').toBe(1)

    // Токен ЛЁГ в файл целиком — иначе боту нечем ходить в Bot API…
    expect(w.onDisk().telegram.botToken).toBe(BOT_TOKEN)
    // …и пары ещё НЕТ: бот не служит никому, пока чат себя не доказал.
    expect(w.onDisk().telegram.chatId).toBe(undefined)
    expect(w.config.telegram.pairing.code).toBe(view.code)

    // ── шаг 2: человек отправил код своему боту в личку ────────────────────────────────
    const t = transport({
      batches: [[msg(1, OWNER_CHAT, `/start ${view.code}`, { first_name: 'Мария', last_name: 'Тестовна' })]],
    })
    const bridge = createTelegramBridge({
      config: w.config,
      fetchImpl: t.fetchImpl,
      log: (l: string) => w.logs.push(l),
      onPaired: w.onPaired,
      now: w.at,
    })!
    expect(bridge, 'токен в конфиге есть — цикл обязан существовать').not.toBe(null)

    expect(await bridge.pollOnce()).toEqual([{ action: 'paired' }])
    expect(t.sent()).toEqual([{ method: 'sendMessage', payload: { chat_id: OWNER_CHAT, text: PAIRED_REPLY } }])

    // Пара записана САМИМ БОТОМ — в файл, а не только в память процесса.
    const disk = w.onDisk()
    expect(disk.telegram.chatId).toBe(String(OWNER_CHAT))
    expect(disk.telegram.chatTitle).toBe('Мария Тестовна')
    // …и код потрачен тем же движением: его в файле больше нет.
    expect(disk.telegram.pairing).toBe(undefined)

    // ── шаг 3: окно показывает состояние, и чат назван ИМЕНЕМ, а не числом ─────────────
    const picture = await w.harness()
    expect(picture.statusCode).toBe(200)
    const link = JSON.parse(picture.body).telegram
    expect(link.status).toBe('linked')
    expect(link.chat).toEqual({ id: String(OWNER_CHAT), title: 'Мария Тестовна' })
    expect(link.code).toBe(null)
    expect(link.tokenTail).toBe(TOKEN_TAIL)

    // ── шаг 4: отключение — тоже из окна, и уносит и токен, и пару ─────────────────────
    const off = await w.post({ action: 'disconnect' })
    expect(off.statusCode).toBe(200)
    expect(JSON.parse(off.body).telegram).toEqual({
      status: 'off',
      tokenTail: null,
      code: null,
      expiresAt: null,
      codeExpired: false,
      chat: null,
    })
    expect(w.onDisk().telegram, 'блок связи должен исчезнуть целиком, а не опустеть').toBe(undefined)
    expect(w.config.telegram).toBe(undefined)
    expect(w.restarts.length, 'отключение тоже обязано остановить цикл сейчас, а не после перезапуска').toBe(2)

    // Ни одного обращения к настоящей сети за весь путь.
    expect(fetchCalls).toBe(0)
  })

  it('чат без имени в Telegram называется числом — и это честнее выдуманного слова', async () => {
    const w = world()
    const view = JSON.parse((await w.post({ action: 'connect', botToken: BOT_TOKEN })).body).telegram
    const t = transport({ batches: [[msg(2, OWNER_CHAT, view.code)]] })
    const bridge = createTelegramBridge({ config: w.config, fetchImpl: t.fetchImpl, onPaired: w.onPaired, now: w.at })!

    expect(await bridge.pollOnce()).toEqual([{ action: 'paired' }])
    expect(w.onDisk().telegram.chatTitle).toBe(undefined)
    expect(telegramLinkView(w.config, { now: w.at() }).chat).toEqual({ id: String(OWNER_CHAT), title: null })
  })

  it('«новый код» не спрашивает токен второй раз — человек не может прочитать его обратно', async () => {
    const w = world()
    const first = JSON.parse((await w.post({ action: 'connect', botToken: BOT_TOKEN })).body).telegram
    w.advance(PAIRING_TTL_MS + 1) // прежний код умер сам

    const again = await w.post({ action: 'code' })
    expect(again.statusCode).toBe(200)
    const view = JSON.parse(again.body).telegram
    expect(view.status).toBe('awaiting_code')
    expect(view.code).not.toBe(first.code)
    expect(view.expiresAt).toBe(w.at() + PAIRING_TTL_MS)
    expect(w.onDisk().telegram.botToken).toBe(BOT_TOKEN) // токен на месте, вводить заново нечего
  })

  it('выдача кода РАСПАРИВАЕТ: живой код рядом с подтверждённой парой был бы вторым входом', async () => {
    const w = world()
    const view = JSON.parse((await w.post({ action: 'connect', botToken: BOT_TOKEN })).body).telegram
    const t = transport({ batches: [[msg(3, OWNER_CHAT, view.code)]] })
    const bridge = createTelegramBridge({ config: w.config, fetchImpl: t.fetchImpl, onPaired: w.onPaired, now: w.at })!
    await bridge.pollOnce()
    expect(telegramLinkView(w.config, { now: w.at() }).status).toBe('linked')

    // «Подключить другой чат» — прежняя пара снимается в том же нажатии, что выдаёт код.
    const res = await w.post({ action: 'code' })
    expect(JSON.parse(res.body).telegram.status).toBe('awaiting_code')
    expect(w.onDisk().telegram.chatId).toBe(undefined)
    expect(w.onDisk().telegram.chatTitle).toBe(undefined)
  })

  it('дверь без применителей отвечает 501, а не тихим успехом', async () => {
    const bare = createFrontServer({ config: { token: TOKEN }, deps: {} })
    const res = mkRes()
    await bare.handle(mkReq('/api/connection/telegram', { action: 'connect', botToken: BOT_TOKEN }), res)
    expect(res.statusCode).toBe(501)
  })

  it('словарь двери закрыт: чужое слово, чужой ключ и пустой токен — 400, и ничего не записано', async () => {
    for (const body of [
      { action: 'pair' },
      { action: 'connect' },
      { action: 'connect', botToken: '   ' },
      { action: 'code', botToken: BOT_TOKEN }, // токен принадлежит одному лишь connect
      { action: 'connect', botToken: BOT_TOKEN, chatId: OWNER_CHAT }, // чат id не называют снаружи
    ] as any[]) {
      const w = world()
      const res = await w.post(body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(existsSync(w.configPath), `${JSON.stringify(body)}: отказ всё-таки писал в файл`).toBe(false)
      expect(w.restarts).toEqual([])
    }
  })

  it('«пара без бота» невозможна: применитель отказывается писать чат, за которым нет токена', () => {
    const w = world()
    expect(() => applyTelegramPair({}, { chatId: OWNER_CHAT }, { env: w.env, launchDir: w.repo })).toThrow(
      InvalidTelegramLinkError,
    )
    expect(existsSync(w.configPath)).toBe(false)
  })

  it('дверь одна, и она в закрытом столе — счёт дверей сдвинут вместе с ней', () => {
    expect(ROUTES['POST /api/connection/telegram']).toBe('handleConnectionTelegram')
    expect(Object.keys(ROUTES)).toHaveLength(64)
    expect(TELEGRAM_ACTIONS).toEqual(['connect', 'code', 'disconnect'])
  })
})

// ══════════════════ 2 · ТОКЕН: ВНУТРЬ — ДА, НАРУЖУ — НИКОГДА ══════════════════

describe('токен не возвращается наружу ни одной дверью и не встречается в логах', () => {
  it('ответ двери и картина окна несут ЧЕТЫРЕ ЗНАКА хвоста и ничего больше', async () => {
    const w = world()
    const connected = await w.post({ action: 'connect', botToken: BOT_TOKEN })
    const picture = await w.harness()

    for (const [where, text] of [
      ['ответ двери подключения', connected.body],
      ['картина /api/harness', picture.body],
    ] as Array<[string, string]>) {
      expectNoSecret(text, where)
      expect(text).toContain(TOKEN_TAIL) // хвост — да, он и есть весь ответ про «какой бот»
    }
    // …и хвост — ЕДИНСТВЕННОЕ, что от токена вообще есть в картине: ни одно другое её поле не
    // является куском токена, как бы картину ни разложили по значениям.
    const link = JSON.parse(picture.body).telegram
    for (const value of Object.values(link)) {
      if (typeof value !== 'string' || value === TOKEN_TAIL) continue
      expect(BOT_TOKEN.includes(value), `поле картины «${value}» — кусок токена`).toBe(false)
    }
  })

  it('отказ на кривом токене называет ФОРМУ и не цитирует значение', async () => {
    const w = world()
    const wrong = `https://evil.example/${SECRET_HALF}`
    const res = await w.post({ action: 'connect', botToken: wrong })

    expect(res.statusCode).toBe(400)
    expectNoSecret(res.body, 'отказ двери')
    expect(res.body, 'отказ процитировал то, что ему прислали — так учётка и попадает в консоль').not.toContain(wrong)
    expect(existsSync(w.configPath)).toBe(false)
  })

  it('логируемая форма конфига схлопывает и токен, и живой код', async () => {
    const w = world()
    await w.post({ action: 'connect', botToken: BOT_TOKEN })

    const loggable = secretsView(w.config)
    expect(loggable.telegram.botToken).toBe('[set]')
    expect(loggable.telegram.pairing.code).toBe('[set]')
    expectNoSecret(JSON.stringify(loggable), 'логируемая форма конфига')
    // …а сам конфиг процесса не тронут: схлопывание — это ВИД, а не правка
    expect(w.config.telegram.botToken).toBe(BOT_TOKEN)
  })

  it('сломанный транспорт: в строках лога цикла нет ни токена, ни его половины', async () => {
    const w = world()
    await w.post({ action: 'connect', botToken: BOT_TOKEN })
    // Ровно та строка, которую пишет настоящий fetch: адрес целиком, с учёткой в пути.
    const boom = new Error(`request to https://api.telegram.org/bot${BOT_TOKEN}/getUpdates failed: ECONNRESET`)
    // Жалоба пишется в самом цикле, а не в одиночном опросе, поэтому здесь запускается цикл;
    // отдых после отказа — то место, где он ждёт, и вместо ожидания цикл останавливается.
    let bridge: any = null
    bridge = createTelegramBridge({
      config: w.config,
      fetchImpl: async () => {
        throw boom
      },
      log: (l: string) => w.logs.push(l),
      sleep: async () => {
        bridge.stop()
      },
      onPaired: w.onPaired,
      now: w.at,
    })!

    await bridge.start()
    expect(w.logs.length, 'цикл промолчал об отказе — тогда и утекать нечему, но и проверять нечего').toBeGreaterThan(0)
    for (const line of w.logs) expectNoSecret(line, 'строка лога')
    expect(w.logs.join('\n')).toContain('bot[REDACTED]')
  })

  it('квитанция пары не несёт учётной записи: наружу уходит номер чата и слово, не токен', async () => {
    const w = world()
    const view = JSON.parse((await w.post({ action: 'connect', botToken: BOT_TOKEN })).body).telegram
    const t = transport({ batches: [[msg(4, OWNER_CHAT, view.code, { title: 'Стройка — прораб' })]] })
    const bridge = createTelegramBridge({
      config: w.config,
      fetchImpl: t.fetchImpl,
      log: (l: string) => w.logs.push(l),
      onPaired: w.onPaired,
      now: w.at,
    })!

    await bridge.pollOnce()
    // всё, что цикл сказал наружу за пару, — и ни в одном месте нет учётки
    expectNoSecret(JSON.stringify(t.calls), 'исходящие вызовы Bot API')
    for (const line of w.logs) expectNoSecret(line, 'строка лога')
    expect(w.onDisk().telegram.chatTitle).toBe('Стройка — прораб')
  })
})

// ══════════════════ 3 · КОД: ОДИН РАЗ И НЕНАДОЛГО ══════════════════

describe('код пайринга одноразовый и с истечением — оба свойства проверяются отказом', () => {
  let w: ReturnType<typeof world>
  let code: string

  beforeEach(async () => {
    w = world()
    code = JSON.parse((await w.post({ action: 'connect', botToken: BOT_TOKEN })).body).telegram.code
  })

  it('второй чат с тем же кодом получает обычный отказ — пара уже занята', async () => {
    const t = transport({
      batches: [[msg(10, OWNER_CHAT, code), msg(11, OTHER_CHAT, code)]],
    })
    const bridge = createTelegramBridge({ config: w.config, fetchImpl: t.fetchImpl, onPaired: w.onPaired, now: w.at })!

    expect(await bridge.pollOnce()).toEqual([{ action: 'paired' }, { action: 'refused' }])
    expect(t.sent()[1]).toEqual({ method: 'sendMessage', payload: { chat_id: OTHER_CHAT, text: STRANGER_REPLY } })
    // чат остался первым — второе предъявление кода не переписало пару
    expect(w.onDisk().telegram.chatId).toBe(String(OWNER_CHAT))
  })

  it('код потрачен СОСТОЯНИЕМ: после записи пары сверять его больше не с чем', async () => {
    const t = transport({ batches: [[msg(12, OWNER_CHAT, code)]] })
    const bridge = createTelegramBridge({ config: w.config, fetchImpl: t.fetchImpl, onPaired: w.onPaired, now: w.at })!
    await bridge.pollOnce()

    // Ни счётчика, ни флага «использован» — блока пары просто нет, и сверять нечего.
    expect(w.config.telegram.pairing).toBe(undefined)
    expect(matchesPairingCode(w.config, code, w.at())).toBe(false)
  })

  it('просроченный код отвергается — и просрочка считается ДО сравнения букв', async () => {
    w.advance(PAIRING_TTL_MS + 1)
    const t = transport({ batches: [[msg(13, OWNER_CHAT, code)]] })
    const bridge = createTelegramBridge({ config: w.config, fetchImpl: t.fetchImpl, onPaired: w.onPaired, now: w.at })!

    expect(await bridge.pollOnce()).toEqual([{ action: 'refused' }])
    expect(t.sent()).toEqual([{ method: 'sendMessage', payload: { chat_id: OWNER_CHAT, text: STRANGER_REPLY } }])
    expect(w.onDisk().telegram.chatId).toBe(undefined)
    // …и правильные буквы просроченного кода не спасают — сравнения не было вовсе
    expect(matchesPairingCode(w.config, code, w.at())).toBe(false)
  })

  it('ровно на границе десяти минут код уже мёртв — «меньше», а не «не больше»', () => {
    const pairing = mintPairing({ now: T0 })
    const cfg: any = { telegram: { botToken: BOT_TOKEN, pairing } }
    expect(matchesPairingCode(cfg, pairing.code, pairing.expiresAt - 1)).toBe(true)
    expect(matchesPairingCode(cfg, pairing.code, pairing.expiresAt)).toBe(false)
    expect(matchesPairingCode(cfg, pairing.code, pairing.expiresAt + 1)).toBe(false)
  })

  it('окно не показывает мёртвый код: состояние «ждёт», код пуст, просрочка названа', async () => {
    w.advance(PAIRING_TTL_MS + 1)
    const link = JSON.parse((await w.harness()).body).telegram
    expect(link.status).toBe('awaiting_code')
    expect(link.code).toBe(null)
    expect(link.codeExpired).toBe(true)
    expect(link.tokenTail).toBe(TOKEN_TAIL)
  })

  it('чужие буквы — обычный отказ незнакомцу, и пара не появляется', async () => {
    const t = transport({ batches: [[msg(14, OWNER_CHAT, 'ABCD-2345'), msg(15, OWNER_CHAT, 'привет')]] })
    const bridge = createTelegramBridge({ config: w.config, fetchImpl: t.fetchImpl, onPaired: w.onPaired, now: w.at })!

    expect(await bridge.pollOnce()).toEqual([{ action: 'refused' }, { action: 'refused' }])
    for (const call of t.sent()) expect(call.payload.text).toBe(STRANGER_REPLY)
    expect(w.config.telegram.chatId).toBe(undefined)
  })

  it('код читается из сообщения так, как его пришлёт человек и как его пришлёт Telegram', () => {
    const pairing = mintPairing({ now: T0 })
    const cfg: any = { telegram: { botToken: BOT_TOKEN, pairing } }
    const bare = normalizeCode(pairing.code)
    for (const text of [pairing.code, pairing.code.toLowerCase(), bare, `/start ${pairing.code}`, ` ${bare} `]) {
      expect(matchesPairingCode(cfg, text, T0), `«${text}» человек считает тем же кодом`).toBe(true)
    }
    // …но код, СЛУЧАЙНО оказавшийся посреди фразы, парой не становится: берётся последнее слово
    expect(matchesPairingCode(cfg, `${pairing.code} и ещё вот что`, T0)).toBe(false)
    expect(codeFromMessage('').length).toBe(0)
    expect(normalizeCode(pairing.code).length).toBe(PAIRING_CODE_LENGTH)
  })

  it('пара, которую не удалось записать, не объявляется сделанной', async () => {
    const t = transport({ batches: [[msg(16, OWNER_CHAT, code)]] })
    const bridge = createTelegramBridge({
      config: w.config,
      fetchImpl: t.fetchImpl,
      log: (l: string) => w.logs.push(l),
      // писатель, который отказал: диск полон, права сняты — что угодно
      onPaired: () => {
        throw new Error('записать не вышло')
      },
      now: w.at,
    })!

    expect(await bridge.pollOnce()).toEqual([{ action: 'refused' }])
    expect(t.sent()[0].payload.text).not.toBe(PAIRED_REPLY)
    // код НЕ потрачен: следующая попытка того же человека ещё может подключить чат
    expect(matchesPairingCode(w.config, code, w.at())).toBe(true)
  })
})
