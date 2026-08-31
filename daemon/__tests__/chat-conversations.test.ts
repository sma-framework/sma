/**
 * chat-conversations.test.ts — КНИГА РАЗЛОЖЕНА ПО РАЗГОВОРАМ, И ИХ ВИДНО СПИСКОМ.
 *
 * Слово владельца 31.08: «почему разговор когда открываю у него нет истории? через раз
 * появляется, может нам разбить разговор на разные чаты? И те которые в процессе условно
 * выполняют что-то, тогда они активные как и в chatgpt».
 *
 * Замер объяснил «через раз» числом: в книге лежало 50 реплик, разложенных по ПЯТНАДЦАТИ
 * беседам. Окно заводило новую почти при каждом открытии, показывало все ходы проекта одной
 * сплошной лентой — и вернуться в прошлую беседу было нечем, потому что списка не было вовсе.
 *
 * Здесь проверяется всё, что иначе ломается молча:
 *   - список собран ПО КНИГЕ: имя из первых слов, время последней реплики, число ходов;
 *   - имя правится рукой и живёт ОТДЕЛЬНО от стенограммы (в промпт беседы не попадает);
 *   - сужение по проекту то же, что у чтения: беседа без проекта в проектный список не лезет;
 *   - живая точка — факт о ПРОЦЕССЕ: она горит, пока ход идёт, и гаснет, когда он кончился,
 *     в том числе когда он кончился ошибкой;
 *   - КРАСНЫЙ ТЕСТ: два открытия окна подряд не плодят двух разговоров.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { createFrontServer, ROUTES } from '../src/front/server.mjs'
import {
  appendTurn,
  handleChatTurn,
  readHistory,
  listConversations,
  renameConversation,
  readTitles,
  conversationTitle,
  createLiveConversations,
  CONVERSATION_TITLE_CAP,
} from '../src/front/chat.mjs'

import * as api from '../../spa/src/api/client'
import { setSelectedProject } from '../../spa/src/api/selected-project'
import { chatConversationsQueryFn } from '../../spa/src/api/queries'
import { openThread, conversationName, conversationOf, UNNAMED_CONVERSATION } from '../../spa/src/screens/chat/thread'

const FRONT_TOKEN = 'c'.repeat(64)

function tmp() {
  return mkdtempSync(join(tmpdir(), 'sma-chat-conv-'))
}

function auth() {
  return { authorization: `Bearer ${FRONT_TOKEN}` }
}

function chatHeaders() {
  return { authorization: `Bearer ${FRONT_TOKEN}`, 'content-type': 'application/json' }
}

function req(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const r: any = Readable.from(payload)
  r.method = method
  r.url = url
  r.headers = { ...headers }
  r.socket = { remoteAddress: '10.9.0.1' }
  return r
}

function res() {
  const out: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      out.statusCode = code
      out.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) out.headers[String(k).toLowerCase()] = v
      return out
    },
    setHeader(k: string, v: any) {
      out.headers[String(k).toLowerCase()] = v
    },
    end(chunk?: any) {
      if (chunk != null) out.body += String(chunk)
      return out
    },
    write(chunk?: any) {
      if (chunk != null) out.body += String(chunk)
      return true
    },
  }
  return out
}

async function hit(front: any, o: any) {
  const r = req(o)
  const s = res()
  await front.handle(r, s)
  return s
}

/** Пустая очередь: разговор её не трогает, но дверь собирает доску с каждым ходом. */
const adapter = { list: async () => [], enqueue: async (t: any) => ({ id: t.id }) }

function frontFor(dir: string, extra: any = {}, configExtra: any = {}) {
  return createFrontServer({
    config: { token: FRONT_TOKEN, workers: [], ...configExtra },
    deps: {
      clock: () => 1_700_000_900_000,
      adapter,
      handleChatTurn,
      readChatHistory: readHistory,
      listChatConversations: listConversations,
      renameChatConversation: renameConversation,
      chatDir: dir,
      ...extra,
    },
  })
}

/** Ход книги с явным временем — порядок списка проверяется по нему. */
function say(dir: string, o: { id: string; text: string; ts: string; role?: string; project?: string }) {
  appendTurn({
    dir,
    turn: {
      conversationId: o.id,
      role: o.role ?? 'user',
      text: o.text,
      ts: o.ts,
      ...(o.project ? { project: o.project } : {}),
    },
  })
}

async function listOf(front: any, query = '') {
  const r = await hit(front, { url: `/api/chat/conversations${query}`, headers: auth() })
  return { status: r.statusCode, ...JSON.parse(r.body || '{}') }
}

// ═════════════════ ДВИЖОК: СПИСОК СОБИРАЕТСЯ ПО КНИГЕ ═════════════════

describe('список разговоров собирается по книге, а не заводится второй правдой', () => {
  it('группирует ходы по нити: имя из первых слов, время последней реплики, число ходов', () => {
    const dir = tmp()
    say(dir, { id: 'conv-1', text: 'Почему упала задача про значок?', ts: '2026-08-30T10:00:00.000Z' })
    say(dir, { id: 'conv-1', text: 'потому что тесты', ts: '2026-08-30T10:00:01.000Z', role: 'assistant' })
    say(dir, { id: 'conv-2', text: 'Что съело лимит?', ts: '2026-08-31T09:00:00.000Z' })

    const rows = listConversations({ dir })

    // свежая — первой: список открывают, чтобы вернуться к последнему, а не к первому
    expect(rows.map((r: any) => r.id)).toEqual(['conv-2', 'conv-1'])
    expect(rows[1]).toMatchObject({
      id: 'conv-1',
      title: 'Почему упала задача про значок?',
      turns: 2,
      lastTs: '2026-08-30T10:00:01.000Z',
      active: false,
    })
  })

  it('имя выводится из слов ЧЕЛОВЕКА: ответ машины описывает свой ход, а не разговор', () => {
    const dir = tmp()
    say(dir, { id: 'conv-1', text: 'Готово: задача поставлена.', ts: '2026-08-30T10:00:00.000Z', role: 'assistant' })
    say(dir, { id: 'conv-1', text: 'Поставь задачу про импорт', ts: '2026-08-30T10:00:01.000Z' })

    expect(listConversations({ dir })[0].title).toBe('Поставь задачу про импорт')
  })

  it('длинное имя урезано по границе слова, а не обрублено посреди него', () => {
    const said = 'Расскажи подробно про эту задачу и про то, что именно в ней уже сделано, а что ещё нет'
    const named = conversationTitle(said) as string
    expect(named.length).toBeLessThanOrEqual(CONVERSATION_TITLE_CAP + 1) // +1 — многоточие
    expect(named.endsWith('…')).toBe(true)
    expect(said.startsWith(named.slice(0, -1))).toBe(true)
    expect(named.slice(0, -1).trim().split(' ').pop()).not.toBe('')
    // пусто — это «без имени», а не выдуманный порядковый номер
    expect(conversationTitle('   ')).toBeNull()
  })

  it('беседа без нити в список не попадает — ходом разговора она и не записывалась', () => {
    const dir = tmp()
    appendTurn({ dir, turn: { role: 'user', text: 'ход без беседы', ts: '2026-08-30T10:00:00.000Z' } })
    expect(listConversations({ dir })).toEqual([])
  })

  it('нечитаемая книга — это «бесед нет», а не ошибка', () => {
    expect(listConversations({ dir: join(tmp(), 'нет-такой-папки') })).toEqual([])
  })

  it('сужение по проекту то же, что у чтения: беседа без проекта в проектный список не лезет', () => {
    const dir = tmp()
    say(dir, { id: 'conv-old', text: 'сказано до проектов', ts: '2026-08-30T10:00:00.000Z' })
    say(dir, { id: 'conv-a', text: 'про альфу', ts: '2026-08-30T11:00:00.000Z', project: 'alpha' })
    say(dir, { id: 'conv-b', text: 'про бету', ts: '2026-08-30T12:00:00.000Z', project: 'beta' })

    expect(listConversations({ dir, project: 'alpha' }).map((r: any) => r.id)).toEqual(['conv-a'])
    expect(listConversations({ dir, project: 'beta' }).map((r: any) => r.id)).toEqual(['conv-b'])
    // …и там, где сужать нечем, видны все три, включая беседу без проекта
    expect(listConversations({ dir }).map((r: any) => r.id)).toEqual(['conv-b', 'conv-a', 'conv-old'])
    expect(listConversations({ dir })[2].project).toBeNull()
  })
})

describe('имя разговора, данное рукой', () => {
  it('перебивает догадку по первым словам и переживает новые ходы', () => {
    const dir = tmp()
    say(dir, { id: 'conv-1', text: 'привет', ts: '2026-08-30T10:00:00.000Z' })
    renameConversation({ dir, conversationId: 'conv-1', title: 'Переезд на новую машину' })
    say(dir, { id: 'conv-1', text: 'и ещё вопрос', ts: '2026-08-30T10:05:00.000Z' })

    expect(listConversations({ dir })[0].title).toBe('Переезд на новую машину')
  })

  it('пустое имя — СНЯТЬ своё имя: возвращаются первые слова разговора', () => {
    const dir = tmp()
    say(dir, { id: 'conv-1', text: 'привет', ts: '2026-08-30T10:00:00.000Z' })
    renameConversation({ dir, conversationId: 'conv-1', title: 'Своё имя' })
    expect(renameConversation({ dir, conversationId: 'conv-1', title: '   ' })).toEqual({ id: 'conv-1', title: null })
    expect(listConversations({ dir })[0].title).toBe('привет')
    expect(readTitles({ dir })).toEqual({})
  })

  it('живёт ОТДЕЛЬНО от стенограммы: в книгу переименование не попадает ни одной строкой', () => {
    const dir = tmp()
    say(dir, { id: 'conv-1', text: 'привет', ts: '2026-08-30T10:00:00.000Z' })
    renameConversation({ dir, conversationId: 'conv-1', title: 'Переезд' })

    // ровно один ход, и это тот, который сказал человек: промпт беседы читает книгу, и
    // переименование, положенное туда, приехало бы в контекст репликой, которой не говорили
    const book = readHistory({ dir, conversationId: 'conv-1' })
    expect(book).toHaveLength(1)
    expect(book[0].text).toBe('привет')
  })

  it('имя подрезано по потолку строки списка', () => {
    const dir = tmp()
    const named = renameConversation({ dir, conversationId: 'conv-1', title: 'я'.repeat(400) })
    expect(named.title).toHaveLength(CONVERSATION_TITLE_CAP)
  })
})

describe('живая точка — факт о процессе, а не о книге', () => {
  it('считает ходы: беседа гаснет с ПОСЛЕДНИМ из них, а не с первым', () => {
    const live = createLiveConversations()
    live.begin('conv-1')
    live.begin('conv-1') // ход из окна и ход с телефона в одной беседе
    live.end('conv-1')
    expect(live.ids()).toEqual(['conv-1'])
    live.end('conv-1')
    expect(live.ids()).toEqual([])
    // лишний конец не уводит счётчик в минус
    live.end('conv-1')
    expect(live.ids()).toEqual([])
  })

  it('без реестра поле честно `false` у всех, а не выдуманная точка', () => {
    const dir = tmp()
    say(dir, { id: 'conv-1', text: 'привет', ts: '2026-08-30T10:00:00.000Z' })
    expect(listConversations({ dir })[0].active).toBe(false)
    expect(listConversations({ dir, live: createLiveConversations() })[0].active).toBe(false)
  })
})

// ═════════════════ ДВЕРИ ═════════════════

describe('GET /api/chat/conversations — список за дверью', () => {
  it('дверь объявлена в замороженной таблице маршрутов', () => {
    expect(ROUTES['GET /api/chat/conversations']).toBe('handleChatConversations')
    expect(ROUTES['POST /api/chat/rename']).toBe('handleChatRename')
  })

  it('отдаёт строки списка, свежую первой, и сужается тем же `?project=`', async () => {
    const dir = tmp()
    say(dir, { id: 'conv-a', text: 'про альфу', ts: '2026-08-30T11:00:00.000Z', project: 'alpha' })
    say(dir, { id: 'conv-b', text: 'про бету', ts: '2026-08-30T12:00:00.000Z', project: 'beta' })
    const front = frontFor(dir)

    const all = await listOf(front)
    expect(all.status).toBe(200)
    expect(all.conversations.map((c: any) => c.id)).toEqual(['conv-b', 'conv-a'])
    expect(Object.keys(all.conversations[0]).sort()).toEqual(['active', 'id', 'lastTs', 'project', 'title', 'turns'])

    const alpha = await listOf(front, '?project=alpha')
    expect(alpha.conversations.map((c: any) => c.id)).toEqual(['conv-a'])
  })

  it('нечитаемая книга — пустой список, никогда не 500', async () => {
    const front = frontFor(join(tmp(), 'нет-такой-папки'))
    const out = await listOf(front)
    expect(out.status).toBe(200)
    expect(out.conversations).toEqual([])
  })

  it('несобранная дверь → 501', async () => {
    const front = createFrontServer({ config: { token: FRONT_TOKEN }, deps: {} })
    const r = await hit(front, { url: '/api/chat/conversations', headers: auth() })
    expect(r.statusCode).toBe(501)
  })
})

describe('POST /api/chat/rename — имя беседы, данное рукой', () => {
  it('переименовывает, и список тут же отвечает новым именем', async () => {
    const dir = tmp()
    say(dir, { id: 'conv-1', text: 'привет', ts: '2026-08-30T10:00:00.000Z' })
    const front = frontFor(dir)

    const r = await hit(front, {
      method: 'POST',
      url: '/api/chat/rename',
      headers: chatHeaders(),
      body: { conversationId: 'conv-1', title: 'Переезд на новую машину' },
    })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ id: 'conv-1', title: 'Переезд на новую машину' })
    expect((await listOf(front)).conversations[0].title).toBe('Переезд на новую машину')
  })

  it('чужое имя нити и лишний ключ отвергаются формой, а не разбираются', async () => {
    const front = frontFor(tmp())
    const bad = await hit(front, {
      method: 'POST',
      url: '/api/chat/rename',
      headers: chatHeaders(),
      body: { conversationId: '../../etc/passwd', title: 'ой' },
    })
    expect(bad.statusCode).toBe(400)

    const extra = await hit(front, {
      method: 'POST',
      url: '/api/chat/rename',
      headers: chatHeaders(),
      body: { conversationId: 'conv-1', title: 'ок', project: 'alpha' },
    })
    expect(extra.statusCode).toBe(400)
  })

  it('несобранная дверь → 501', async () => {
    const front = createFrontServer({ config: { token: FRONT_TOKEN }, deps: {} })
    const r = await hit(front, {
      method: 'POST',
      url: '/api/chat/rename',
      headers: chatHeaders(),
      body: { conversationId: 'conv-1', title: 'ок' },
    })
    expect(r.statusCode).toBe(501)
  })
})

describe('беседа, в которой идёт ход, помечена активной', () => {
  it('точка горит ПОКА ход идёт и гаснет, когда он кончился', async () => {
    const dir = tmp()
    say(dir, { id: 'conv-1', text: 'привет', ts: '2026-08-30T10:00:00.000Z' })
    let during: any = null
    let front: any = null
    front = frontFor(dir, {
      chatLive: createLiveConversations(),
      handleChatTurn: async ({ conversationId, deps }: any) => {
        deps.onConversation(conversationId)
        during = await listOf(front)
        return { conversationId, kind: 'free', answer: { kind: 'text', text: 'ок' } }
      },
    })

    await hit(front, {
      method: 'POST',
      url: '/api/chat',
      headers: chatHeaders(),
      body: { text: 'что там?', conversationId: 'conv-1' },
    })

    expect(during.conversations[0]).toMatchObject({ id: 'conv-1', active: true })
    expect((await listOf(front)).conversations[0].active).toBe(false)
  })

  it('ход, упавший с ошибкой, — это ЗАКОНЧИВШИЙСЯ ход, а не вечно активная беседа', async () => {
    const dir = tmp()
    say(dir, { id: 'conv-1', text: 'привет', ts: '2026-08-30T10:00:00.000Z' })
    const live = createLiveConversations()
    const front = frontFor(dir, {
      chatLive: live,
      handleChatTurn: async ({ conversationId, deps }: any) => {
        deps.onConversation(conversationId)
        throw new Error('движок упал')
      },
    })

    await hit(front, {
      method: 'POST',
      url: '/api/chat',
      headers: chatHeaders(),
      body: { text: 'что там?', conversationId: 'conv-1' },
    })

    expect(live.ids()).toEqual([])
    expect((await listOf(front)).conversations[0].active).toBe(false)
  })

  it('сорвавшийся слушатель пометки ход не роняет — точка украшение, ответ нет', async () => {
    const dir = tmp()
    const out = await handleChatTurn({
      text: 'Что съело лимит?',
      deps: {
        adapter,
        historyDir: dir,
        readUsageRows: () => [],
        onConversation: () => {
          throw new Error('реестр сломан')
        },
      },
    })
    expect(out.conversationId).toMatch(/^conv-/)
    expect(out.answer.text).toBeTruthy()
  })
})

// ═════════════════ КРАСНЫЙ ТЕСТ ВЛАДЕЛЬЦА ═════════════════

describe('КРАСНЫЙ ТЕСТ: два открытия окна подряд не плодят двух разговоров', () => {
  it('второе открытие ПРОДОЛЖАЕТ первую беседу — в книге остаётся одна нить', async () => {
    const dir = tmp()
    const front = frontFor(dir)
    const post = async (body: any) =>
      JSON.parse((await hit(front, { method: 'POST', url: '/api/chat', headers: chatHeaders(), body })).body)

    // ПЕРВОЕ ОТКРЫТИЕ: разговоров ещё не было — правило открытия честно отвечает «нити нет»,
    // и первый же ход заводит первую беседу. Это единственный случай, когда её заводит не рука.
    const open1 = (await listOf(front)).conversations
    expect(openThread(open1)).toBeUndefined()
    const first = await post({ text: 'Что съело лимит?' })

    // ВТОРОЕ ОТКРЫТИЕ ОКНА: то же правило поднимает ПОСЛЕДНЮЮ беседу, а не заводит новую.
    const open2 = (await listOf(front)).conversations
    expect(openThread(open2)).toBe(first.conversationId)
    const second = await post({ text: 'Что с задачей про импорт?', conversationId: openThread(open2) })
    expect(second.conversationId).toBe(first.conversationId)

    // ТРЕТЬЕ ОТКРЫТИЕ: в списке по-прежнему ОДИН разговор, а не три.
    const open3 = (await listOf(front)).conversations
    expect(open3).toHaveLength(1)
    expect(open3[0].turns).toBe(4) // два вопроса и два ответа — одной нитью
    expect(openThread(open3)).toBe(first.conversationId)
  })

  it('новая беседа заводится РУКОЙ — и тогда их честно две', async () => {
    const dir = tmp()
    const front = frontFor(dir)
    const post = async (body: any) =>
      JSON.parse((await hit(front, { method: 'POST', url: '/api/chat', headers: chatHeaders(), body })).body)

    const first = await post({ text: 'Что съело лимит?' })
    // «Новый разговор» — единственное место, где окно намеренно не шлёт имени нити
    const second = await post({ text: 'Что с задачей про импорт?' })
    expect(second.conversationId).not.toBe(first.conversationId)

    const rows = (await listOf(front)).conversations
    expect(rows).toHaveLength(2)
    expect(rows.map((c: any) => c.id)).toContain(second.conversationId)
  })

  it('две новых беседы в одну миллисекунду — две беседы, а не молча слипшаяся одна', async () => {
    const dir = tmp()
    // часы стоят: до хвоста у имени это давало ОДНО имя обеим нитям, и второй разговор
    // дописывался в первый — ровно то склеивание, от которого затевался список
    const front = frontFor(dir, { clock: () => 1_700_000_900_000 })
    const post = async (body: any) =>
      JSON.parse((await hit(front, { method: 'POST', url: '/api/chat', headers: chatHeaders(), body })).body)

    const a = await post({ text: 'Что съело лимит?' })
    const b = await post({ text: 'Что с задачей про импорт?' })

    expect(a.conversationId).not.toBe(b.conversationId)
    expect((await listOf(front)).conversations).toHaveLength(2)
  })
})

// ═════════════════ ПРОВОДА ОКНА ═════════════════

describe('провода окна: список спрашивается сужённым, имя правится дверью', () => {
  beforeEach(() => setSelectedProject(null))
  afterEach(() => {
    vi.unstubAllGlobals()
    setSelectedProject(null)
  })

  function stubFetch(body: unknown) {
    const calls: { url: string; method: string; body?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
      }),
    )
    return calls
  }

  it('в адрес списка уходит проект из зеркала, а без него — «сужать нечем»', async () => {
    const calls = stubFetch({ conversations: [] })
    setSelectedProject('sma-dev')
    await chatConversationsQueryFn()
    expect(calls[0].url).toBe('/api/chat/conversations?project=sma-dev')

    setSelectedProject(null)
    await chatConversationsQueryFn()
    expect(calls[1].url).toBe('/api/chat/conversations')
  })

  it('лента сужается ИМЕНЕМ НИТИ — без этого на неё приезжали все разговоры подряд', async () => {
    const calls = stubFetch({ turns: [] })
    await api.getChatHistory({ conversationId: 'conv-7', limit: 200 })
    expect(calls[0].url).toBe('/api/chat/history?limit=200&conversationId=conv-7')
  })

  it('переименование уходит своей дверью', async () => {
    const calls = stubFetch({ id: 'conv-7', title: 'Переезд' })
    await api.renameConversation({ conversationId: 'conv-7', title: 'Переезд' })
    expect(calls[0]).toMatchObject({ url: '/api/chat/rename', method: 'POST' })
    expect(JSON.parse(calls[0].body as string)).toEqual({ conversationId: 'conv-7', title: 'Переезд' })
  })
})

describe('правило открытия и имя строки списка', () => {
  const rows = [
    { id: 'conv-b', title: 'про бету', lastTs: '2026-08-30T12:00:00.000Z', turns: 2, project: 'beta', active: true },
    { id: 'conv-a', title: null, lastTs: '2026-08-30T11:00:00.000Z', turns: 4, project: 'alpha', active: false },
  ]

  it('открытие поднимает свежую беседу списка, а порядок НЕ пересчитывает', () => {
    expect(openThread(rows)).toBe('conv-b')
  })

  it('пустой список — «беседы нет», и следующий ход заведёт первую', () => {
    expect(openThread([])).toBeUndefined()
    expect(openThread(undefined)).toBeUndefined()
  })

  it('беседа, уехавшая за край книги, — это «её больше не видно», а не пустое имя', () => {
    expect(conversationOf(rows, 'conv-a')?.turns).toBe(4)
    expect(conversationOf(rows, 'conv-нет')).toBeUndefined()
    expect(conversationOf(rows, undefined)).toBeUndefined()
  })

  it('беседа без имени называется честно, а не выдуманным номером', () => {
    expect(conversationName(rows[0])).toBe('про бету')
    expect(conversationName(rows[1])).toBe(UNNAMED_CONVERSATION)
    expect(conversationName(undefined)).toBe(UNNAMED_CONVERSATION)
  })
})
