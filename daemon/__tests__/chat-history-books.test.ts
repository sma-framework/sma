/**
 * chat-history-books.test.ts — РАЗГОВОР ОТВЕЧАЕТ О ПРОШЛОМ ПО КНИГАМ, А НЕ ПО ДОСКЕ.
 *
 * Замер, с которого началась эта работа: поиск по четырём книгам (журнал, прогоны, уроки,
 * стенограммы) был только у экрана «Поиск», а у разговора провода к нему не было вовсе. На
 * «что было вчера с задачей» разговор отвечал нынешним статусом строки — то есть не тем, о
 * чём спросили, — а чего доска не знает, то договаривала свободная ветка из общих соображений.
 *
 * Здесь этот провод утверждается по шагам, и последний шаг — настоящий:
 *
 *   ВОПРОС О ПРОШЛОМ ОПОЗНАЁТСЯ, и ни у одной старой ветки он ничего не отнимает.
 *   ЗАПРОС СОБИРАЕТСЯ ИЗ СЛОВ ЧЕЛОВЕКА — без вопросительной обвязки, а идентификатор задачи,
 *     если он назван, бьёт всё остальное.
 *   ХОД ИДЁТ В КНИГИ ВЫДАННОЙ СПОСОБНОСТЬЮ и не будит ни одной сессии (шпион-порождатель
 *     обязан остаться нетронутым: вопрос о прошлом — это чтение, а не догадка модели).
 *   ОТВЕТ НЕСЁТ ПУТЬ ЗАПИСИ — цитата без места, откуда она взята, неотличима от пересказа.
 *   СПОСОБНОСТИ НЕТ — ОТВЕТ ГОВОРИТ ОБ ЭТОМ СЛОВАМИ, а не сваливается в догадку.
 *   И СКВОЗЬ ВСЮ ДОРОГУ: дверь /api/chat → движок разговора → НАСТОЯЩИЙ читатель книг
 *     (scripts/sma/lib/history-search.mjs) над засеянными книгами на диске.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { describe, it, expect } from 'vitest'

import { searchHistory } from '../../scripts/sma/lib/history-search.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { answerToText } from '../src/telegram/poll.mjs'
import {
  classifyTurn,
  handleChatTurn,
  historyQuery,
  historyWidened,
  recordPath,
  answerHistory,
  readHistory,
  HISTORY_BOOK_TITLES,
  HISTORY_HITS_SHOWN,
  HISTORY_NO_DOOR_TEXT,
  HISTORY_QUERY_WORDS,
} from '../src/front/chat.mjs'

const FRONT_TOKEN = 'h'.repeat(64)
const tmp = () => mkdtempSync(join(tmpdir(), 'sma-chat-books-'))

/** Задача, о прошлом которой спрашивают. Идентификатор той же чеканки, что и у очереди. */
const TASK_ID = 'R-1700000123456'

const WORKERS = [{ id: 'max-1', account: 'max-1', name: 'Строитель', lane: 'prod' }]

/** Строка очереди: доска знает о задаче только НЫНЕШНЕЕ — это и есть не тот ответ. */
const ROWS = [{ id: TASK_ID, title: 'Импорт агентов', status: 'queued', lane: 'prod' }]

/** Порождатель, который КРИЧИТ: ответ по книгам не имеет права будить сессию. */
function spawnerSpy() {
  const calls: any[] = []
  return {
    calls,
    fn: (opts: any) => {
      calls.push(opts)
      throw new Error('вопрос о прошлом отвечается записью, а не сессией модели')
    },
  }
}

/** Очередь: читать можно, писать — нет, ровно как и во всех остальных ходах разговора. */
function adapterSpy() {
  const enqueued: any[] = []
  return {
    enqueued,
    adapter: {
      list: async () => ROWS,
      enqueue: async (t: any) => {
        enqueued.push(t)
        throw new Error('the chat engine has no path to the queue')
      },
    },
  }
}

/** Шпион книг: запоминает КАЖДЫЙ запрос и отвечает тем, что ему велели отдать. */
function booksSpy(answers: any[]) {
  const asked: any[] = []
  let n = 0
  return {
    asked,
    fn: async (args: any) => {
      asked.push(args)
      const out = answers[Math.min(n, answers.length - 1)]
      n += 1
      return out
    },
  }
}

function chatDeps(dir: string, extra: any = {}) {
  const spawner = spawnerSpy()
  const q = adapterSpy()
  return {
    spawner,
    q,
    deps: {
      adapter: q.adapter,
      config: { workers: WORKERS },
      historyDir: dir,
      clock: () => 1_700_000_900_000,
      spawnWorker: spawner.fn,
      ...extra,
    },
  }
}

/**
 * Четыре книги на диске — те же четыре, что читает терминал, засеянные словом задачи.
 * Возвращает корень и готовый читатель, настроенный ровно на них (настоящая история машины
 * не читается ни разу).
 */
function seedBooks() {
  const root = mkdtempSync(join(tmpdir(), 'sma-books-'))
  const journalDir = join(root, '.sma', 'journal')
  mkdirSync(journalDir, { recursive: true })
  writeFileSync(
    join(journalDir, 'Окно-1.jsonl'),
    `${JSON.stringify({
      ts: '2026-09-02T09:15:00.000Z',
      terminal: 'Окно-1',
      seq: 1,
      type: 'claim',
      scope: `задача ${TASK_ID} — импорт агентов`,
    })}\n${JSON.stringify({ ts: '2026-09-02T09:40:00.000Z', terminal: 'Окно-1', seq: 2, type: 'release', scope: 'другое' })}\n`,
    'utf8',
  )

  const execDir = join(root, '.sma', 'exec')
  mkdirSync(execDir, { recursive: true })

  const corpusDir = join(root, '.claude', 'memory')
  mkdirSync(corpusDir, { recursive: true })

  const logsDir = join(root, 'logs') // пусто: стенограмм этой машины тест не касается
  mkdirSync(logsDir, { recursive: true })

  const reader = ({ query, limit }: any) =>
    searchHistory({
      query,
      limit,
      journalDir,
      execDir,
      corpusDir,
      logsDir,
      env: {},
      repoRoot: root,
    })
  return { root, reader, journalRel: join('.sma', 'journal', 'Окно-1.jsonl') }
}

// ── дверь: тот же поддельный req/res, которым водят фронт остальные наборы ──

function req(o: any = {}) {
  const { method = 'POST', url = '/api/chat', headers = {}, body } = o
  const payload = body == null ? [] : [Buffer.from(JSON.stringify(body))]
  const r: any = Readable.from(payload)
  r.method = method
  r.url = url
  r.headers = { authorization: `Bearer ${FRONT_TOKEN}`, 'content-type': 'application/json', ...headers }
  r.socket = { remoteAddress: '10.0.0.1' }
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

async function hit(front: any, o: any) {
  const request = req(o)
  const response = res()
  await front.handle(request, response)
  return response
}

describe('вопрос о прошлом опознаётся — и ничего не отнимает у старых веток', () => {
  it('«что было», «кто трогал», «какая квитанция» идут в книги', () => {
    for (const q of [
      'Что было вчера с задачей про импорт?',
      'Кто трогал импорт агентов на прошлой неделе?',
      `Какая квитанция у задачи ${TASK_ID}?`,
      'Чем закончилось с переносом писем?',
    ]) {
      expect(classifyTurn(q), q).toBe('history')
    }
  })

  it('старые ветки читаются ровно как прежде — новый словарь ни у одной не крадёт вопрос', () => {
    expect(classifyTurn('Почему упала задача про значок тестов?')).toBe('fail-reason')
    expect(classifyTurn('Что съело ночной лимит?')).toBe('spend')
    expect(classifyTurn('Что с задачей про импорт?')).toBe('status')
    expect(classifyTurn('Поставь длинную задачу: переписать импорт агентов')).toBe('task-prod')
    expect(classifyTurn('Как лучше подойти к переносу писем?')).toBe('free')
    // «сколько потратили вчера» — вопрос о деньгах, и слово «вчера» его не уводит
    expect(classifyTurn('Сколько потратили вчера?')).toBe('spend')
  })
})

describe('запрос собирается из слов человека', () => {
  it('идентификатор задачи бьёт всё остальное — он один и тот же во всех четырёх книгах', () => {
    expect(historyQuery(`Что было вчера с задачей ${TASK_ID}?`)).toBe(TASK_ID)
  })

  it('вопросительная обвязка в книги не едет, и слов не больше трёх', () => {
    expect(historyQuery('Что было вчера с задачей про импорт агентов?')).toBe('импорт агентов')
    const many = historyQuery('Что было с импортом агентов, письмами, значком и очередью?')
    expect(many.split(' ')).toHaveLength(HISTORY_QUERY_WORDS)
    // вопрос без единого содержательного слова — не запрос, и выдумывать его нечем
    expect(historyQuery('Что было вчера?')).toBe('')
  })

  it('второй заход — то же слово человека, только одно', () => {
    expect(historyWidened('импорт агентов')).toBe('агентов')
    expect(historyWidened('импорт')).toBe('')
  })
})

describe('путь записи показывается, а чужой каталог — нет', () => {
  it('внутри дерева проекта путь относительный, снаружи — одно имя файла', () => {
    expect(recordPath('/home/dev/proj/.sma/journal/a.jsonl', '/home/dev/proj')).toBe('.sma/journal/a.jsonl')
    expect(recordPath('C:\\Users\\a\\proj\\.sma\\exec\\1.jsonl', 'C:/Users/a/proj')).toBe('.sma/exec/1.jsonl')
    // стенограмма движка лежит в домашнем каталоге человека — раскладка машины не уезжает
    expect(recordPath('/home/dev/.claude/projects/x/session-a.jsonl', '/home/dev/proj')).toBe('session-a.jsonl')
  })

  it('ответ цитирует не больше названного числа записей, и каждая названа книгой', () => {
    const hits = Array.from({ length: HISTORY_HITS_SHOWN + 3 }, (_, i) => ({
      source: 'journal',
      file: '/p/.sma/journal/a.jsonl',
      ts: '2026-09-02T09:15:00.000Z',
      fragment: `строка ${i}`,
    }))
    const out = answerHistory({ query: 'импорт', found: { hits }, repoDir: '/p' })
    expect(out.sources).toHaveLength(HISTORY_HITS_SHOWN)
    expect(out.sources[0].book).toBe(HISTORY_BOOK_TITLES.journal)
    expect(out.sources[0].path).toBe('.sma/journal/a.jsonl')
  })
})

describe('ход разговора идёт в книги — и не будит ни одной сессии', () => {
  it('ответ несёт книгу, путь записи и саму строку', async () => {
    const dir = tmp()
    const books = booksSpy([
      {
        hits: [
          {
            source: 'journal',
            file: '/p/.sma/journal/Окно-1.jsonl',
            ts: '2026-09-02T09:15:00.000Z',
            fragment: `задача ${TASK_ID} — импорт агентов`,
          },
        ],
      },
    ])
    const { deps, spawner, q } = chatDeps(dir, { searchHistory: books.fn, repoDir: '/p' })
    const out = await handleChatTurn({ text: `Что было вчера с задачей ${TASK_ID}?`, deps })

    expect(out.kind).toBe('history')
    expect(out.answer.kind).toBe('fact')
    expect(books.asked).toHaveLength(1)
    expect(books.asked[0].query).toBe(TASK_ID)
    expect(out.answer.sources).toHaveLength(1)
    expect(out.answer.sources[0]).toMatchObject({
      book: HISTORY_BOOK_TITLES.journal,
      path: '.sma/journal/Окно-1.jsonl',
      ts: '2026-09-02T09:15:00.000Z',
    })
    expect(out.answer.sources[0].fragment).toContain('импорт агентов')
    expect(spawner.calls).toHaveLength(0) // чтение, а не догадка модели
    expect(q.enqueued).toHaveLength(0) // и руки по-прежнему связаны

    // цитата пережила ход: беседа, открытая завтра, покажет ту же запись
    const turns = readHistory({ dir, conversationId: out.conversationId })
    expect(turns).toHaveLength(2)
    expect(turns[1].sources[0].path).toBe('.sma/journal/Окно-1.jsonl')

    // и на телефоне, где карточек нет, та же запись доезжает СЛОВАМИ
    const said = answerToText(out.answer)
    expect(said).toContain('.sma/journal/Окно-1.jsonl')
    expect(said).toContain(HISTORY_BOOK_TITLES.journal)
    expect(said).toContain('импорт агентов')
  })

  it('пусто по трём словам — второй заход одним словом человека, и он назван в ответе', async () => {
    const dir = tmp()
    const books = booksSpy([
      { hits: [] },
      { hits: [{ source: 'lesson', file: '/p/.claude/memory/a.md', ts: null, fragment: 'урок про агентов' }] },
    ])
    const { deps } = chatDeps(dir, { searchHistory: books.fn, repoDir: '/p' })
    const out = await handleChatTurn({ text: 'Что было вчера с импортом агентов?', deps })

    expect(books.asked.map((a: any) => a.query)).toEqual(['импортом агентов', 'импортом'])
    expect(out.answer.sources[0]).toMatchObject({ book: HISTORY_BOOK_TITLES.lesson, path: '.claude/memory/a.md' })
    expect(out.answer.text).toContain('импортом') // ответ называет, по каким словам он найден
  })

  it('не нашлось — так и сказано, с перечнем прочитанных книг и без единой догадки', async () => {
    const dir = tmp()
    const books = booksSpy([{ hits: [] }])
    const { deps, spawner } = chatDeps(dir, { searchHistory: books.fn })
    const out = await handleChatTurn({ text: 'Что было вчера с пеликаном?', deps })

    expect(out.answer.sources).toEqual([])
    for (const book of Object.values(HISTORY_BOOK_TITLES)) expect(out.answer.text).toContain(book)
    expect(spawner.calls).toHaveLength(0)
  })

  it('книг не выдали — ход говорит об этом словами, а не сваливается в догадку', async () => {
    const dir = tmp()
    const { deps, spawner } = chatDeps(dir)
    const out = await handleChatTurn({ text: 'Что было вчера с импортом агентов?', deps })

    expect(out.answer.text).toBe(HISTORY_NO_DOOR_TEXT)
    expect(spawner.calls).toHaveLength(0)
  })

  it('книги отказали — это новость, а не молчание и не выдуманный ответ', async () => {
    const dir = tmp()
    const { deps } = chatDeps(dir, {
      searchHistory: async () => {
        throw new Error('книги не открылись')
      },
    })
    const out = await handleChatTurn({ text: 'Что было вчера с импортом агентов?', deps })
    expect(out.answer.sources).toEqual([])
    expect(out.answer.text).not.toContain('книги не открылись') // внутренности наружу не едут
    expect(out.answer.error).toBe('history-unreadable')
  })
})

describe('сквозь всю дорогу: дверь → движок → НАСТОЯЩИЙ читатель четырёх книг', () => {
  it('вопрос о прошлой задаче возвращается цитатой из журнала с путём записи', async () => {
    const dir = tmp()
    const { root, reader, journalRel } = seedBooks()
    const spawner = spawnerSpy()
    const q = adapterSpy()
    const front = createFrontServer({
      config: { token: FRONT_TOKEN, workers: WORKERS },
      deps: {
        clock: () => 1_700_000_900_000,
        adapter: q.adapter,
        handleChatTurn,
        readChatHistory: readHistory,
        chatDir: dir,
        spawnWorker: spawner.fn,
        searchHistory: reader,
        repoDir: root,
      },
    })

    const answer = await hit(front, { body: { text: `Что было вчера с задачей ${TASK_ID}?` } })
    expect(answer.statusCode).toBe(200)
    const out = JSON.parse(answer.body)

    expect(out.kind).toBe('history')
    expect(out.answer.sources.length).toBeGreaterThan(0)
    const fromJournal = out.answer.sources.find((s: any) => s.book === HISTORY_BOOK_TITLES.journal)
    expect(fromJournal).toBeTruthy()
    expect(fromJournal.fragment).toContain(TASK_ID)
    expect(fromJournal.ts).toBe('2026-09-02T09:15:00.000Z')
    // путь записи — тот самый файл журнала, относительно дерева проекта
    expect(fromJournal.path).toBe(journalRel.replace(/\\/g, '/'))
    // ссылка на запись книги — то, чего у ответа по доске быть не может
    expect(out.answer.text).toContain(TASK_ID)
    expect(spawner.calls).toHaveLength(0)
  })
})
