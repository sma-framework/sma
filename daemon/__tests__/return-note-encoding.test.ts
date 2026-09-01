/**
 * Записка возврата доезжает до работника БАЙТ-В-БАЙТ — весь путь под одной контрольной строкой.
 *
 * ЧТО БЫЛО ИЗМЕРЕНО (01.09, возврат дубля). Работник следующего подхода прочитал записку
 * задачи как сплошные `?` — «читал её частично», не понял приказ и написал ещё кода на
 * устаревшей базе. В базе очереди (`sma_task_attempts.returned_note`, кодировка UTF8) записка
 * УЖЕ лежала битой: 87 и 107 знаков `?` в двух строках подряд. Значит порча случилась ДО двери,
 * а не за ней, и это перепроверено прогоном контрольной строки «кириллица + эмодзи + ASCII»:
 *
 *   PowerShell 5.1, `$OutputEncoding` по умолчанию ASCII. Строка, ВЕРНАЯ в памяти оболочки
 *   (коды 1050,1054,1053,…), доезжает до дочернего процесса АРГУМЕНТОМ целой (те же коды) —
 *   и приезжает восемью знаками `?` (коды 63,63,…), если её ПРОПУСТИТЬ ЧЕРЕЗ КОНВЕЙЕР `|`.
 *   Оболочка кодирует конвейер в ASCII перед тем, как отдать байты, и всякий не-ASCII знак
 *   становится `?` ещё до того, как что-либо уходит в сеть.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ВСЁ РАВНО НУЖЕН. Порча живёт у отправителя, но цена класса — у продукта:
 * возврат есть главный канал управления работником, и молчаливая потеря записки превращает
 * каждый возврат в лотерею. Пути от двери до работника четыре звена, и ни одно из них не было
 * закрыто проверкой: дверь читает тело, строка очереди несёт `note`, сборщик вклеивает её в
 * промпт, spawn отдаёт промпт в stdin ребёнка. Каждое из четырёх можно сломать безобидной
 * правкой («сложим чанки построчно», «запишем latin1»), и сломанное звено не упадёт — оно
 * тихо отдаст работнику мусор. Поэтому здесь ОДНА контрольная строка и ОДИН sha256, которые
 * обязаны совпасть на каждой станции.
 *
 * Тесты:
 *   1. Дверь → строка очереди: `note` доезжает до записи в базу и до строки очереди
 *      байт-в-байт (сравнивается sha256 UTF-8 байтов, не «похожесть» строк).
 *   2. Многобайтовый знак, РАЗОРВАННЫЙ между чанками тела: `Buffer.concat` до декодирования —
 *      единственная защита от чтения половины кодовой точки, и она проверяется на разрыве.
 *   3. Строка очереди → промпт: записка вклеена дословно, а не пересказана.
 *   4. Промпт → stdin работника: на трубу уходят ровно байты UTF-8 промпта.
 *   5. Весь путь одной цепочкой: одна строка, один sha256, четыре станции.
 */

import { describe, it, expect } from 'vitest'
import { Readable, PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'

import { createFrontServer } from '../src/front/server.mjs'
import { buildTaskPrompt } from '../src/runner/args.mjs'
import { spawnWorker } from '../src/runner/spawn.mjs'

const TOKEN = 'a'.repeat(64)

/**
 * КОНТРОЛЬНАЯ СТРОКА — кириллица, эмодзи и ASCII в одной. Три класса нужны все три: ASCII
 * переживает любую порчу и потому один ничего не доказывает; кириллица ловит однобайтовые
 * кодовые страницы; эмодзи (вне BMP, суррогатная пара в UTF-16 и четыре байта в UTF-8) ловит
 * ещё и то, что режет по кодовым единицам вместо кодовых точек.
 */
const CONTROL = 'КОНТРОЛЬ: съешь ещё этих мягких булок | ASCII abc123 | эмодзи 🙂✅ | ЁёЙй'

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')
const CONTROL_SHA = sha(CONTROL)

// ── fake req/res (та же форма, что в front-auth.test.ts) ──

function mkReq(o: any = {}) {
  const { method = 'POST', url = '/api/return', headers = {}, chunks = [], remote = '10.0.0.1' } = o
  const req: any = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers }
  req.socket = { remoteAddress: remote }
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
    setHeader(k: string, v: any) {
      res.headers[k.toLowerCase()] = v
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()]
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

/**
 * Дверь возврата с записывающими зависимостями: `casExec` ловит то, что уходит в колонку
 * `returned_note`, `adapter.enqueue` — строку очереди целиком.
 */
function mkFront() {
  const seen: any = { casNote: null, task: null }
  const deps = {
    casExec: async (_sql: string, params: any[]) => {
      seen.casNote = params[1] // SET status = $1, returned_note = $2 (см. casTransition)
      return { rows: [{ id: 'T-1' }] }
    },
    taskTable: 'sma_task_attempts',
    adapter: {
      list: async () => [{ id: 'T-1', title: 'имя задачи', attempt: 1, lane: 'prod', data: {} }],
      enqueue: async (task: any) => {
        seen.task = task
        return { ok: true }
      },
    },
    clock: () => 1756700000000,
  }
  return { front: createFrontServer({ config: { token: TOKEN }, deps }), seen }
}

/** Тело возврата, нарезанное на чанки так, как их отдаёт сокет. */
function bodyChunks(note: string, splitAt?: number) {
  const buf = Buffer.from(JSON.stringify({ taskId: 'T-1', note }), 'utf8')
  return splitAt === undefined ? [buf] : [buf.subarray(0, splitAt), buf.subarray(splitAt)]
}

async function postReturn(front: any, chunks: Buffer[]) {
  const res = mkRes()
  await front.handle(mkReq({ chunks }), res)
  return res
}

describe('записка возврата: дверь → строка очереди', () => {
  it('доезжает байт-в-байт и до записи в базу, и до строки очереди', async () => {
    const { front, seen } = mkFront()
    const res = await postReturn(front, bodyChunks(CONTROL))

    expect(res.statusCode).toBe(200)
    // Не «строки похожи», а СОВПАДАЮТ БАЙТЫ: сравнение sha256 не проходит ни на одной
    // однобайтовой подмене, ни на нормализации юникода, ни на потерянной кодовой точке.
    expect(sha(String(seen.casNote))).toBe(CONTROL_SHA)
    expect(sha(String(seen.task.note))).toBe(CONTROL_SHA)
    expect(seen.task.source).toBe('return')
    expect(seen.task.attempt).toBe(2)
  })

  it('многобайтовый знак, разорванный между чанками тела, собирается целым', async () => {
    // РАЗРЫВ СТАВИТСЯ НЕ НАУГАД: он приходится ВНУТРЬ четырёхбайтовой кодовой точки эмодзи.
    // Чтение чанков по одному («chunk.toString() + …») здесь отдаёт две замены U+FFFD и
    // разваливает JSON — то есть отказ виден, а не молчалив, только пока стоит этот тест.
    const whole = Buffer.from(JSON.stringify({ taskId: 'T-1', note: CONTROL }), 'utf8')
    const emoji = Buffer.from('🙂', 'utf8')
    const at = whole.indexOf(emoji) + 2 // ровно посреди кодовой точки
    expect(at).toBeGreaterThan(2)

    const { front, seen } = mkFront()
    const res = await postReturn(front, bodyChunks(CONTROL, at))

    expect(res.statusCode).toBe(200)
    expect(sha(String(seen.task.note))).toBe(CONTROL_SHA)
  })
})

describe('записка возврата: строка очереди → промпт → работник', () => {
  it('вклеивается в промпт дословно', async () => {
    const { front, seen } = mkFront()
    await postReturn(front, bodyChunks(CONTROL))

    const prompt = buildTaskPrompt({ task: seen.task })
    expect(prompt).toContain(`note: ${CONTROL}`)
  })

  it('уходит в stdin работника ровно байтами UTF-8 промпта', async () => {
    const { front, seen } = mkFront()
    await postReturn(front, bodyChunks(CONTROL))
    const prompt = buildTaskPrompt({ task: seen.task })

    // Труба НАСТОЯЩАЯ (PassThrough), потому что проверяется именно превращение строки в
    // байты: подделка, которая копит write() как строки, это превращение и пропустила бы.
    const pipe = new PassThrough()
    const written: Buffer[] = []
    pipe.on('data', (c: Buffer) => written.push(Buffer.from(c)))
    const closed = new Promise<void>((resolve) => pipe.on('end', () => resolve()))

    const child: any = { pid: 4242, kill: () => {}, stdin: pipe, on: () => child }
    spawnWorker({ bin: 'claude', args: [], cwd: __dirname, env: {}, prompt, spawnImpl: () => child })
    await closed

    expect(Buffer.concat(written).equals(Buffer.from(prompt, 'utf8'))).toBe(true)
  })

  it('весь путь одной цепочкой: одна строка, один sha256, четыре станции', async () => {
    const { front, seen } = mkFront()
    await postReturn(front, bodyChunks(CONTROL))
    const prompt = buildTaskPrompt({ task: seen.task })

    const pipe = new PassThrough()
    const written: Buffer[] = []
    pipe.on('data', (c: Buffer) => written.push(Buffer.from(c)))
    const closed = new Promise<void>((resolve) => pipe.on('end', () => resolve()))
    const child: any = { pid: 7, kill: () => {}, stdin: pipe, on: () => child }
    spawnWorker({ bin: 'claude', args: [], cwd: __dirname, env: {}, prompt, spawnImpl: () => child })
    await closed

    const stations = {
      'запись в базу': String(seen.casNote),
      'строка очереди': String(seen.task.note),
      промпт: prompt,
      'stdin работника': Buffer.concat(written).toString('utf8'),
    }
    for (const [where, text] of Object.entries(stations)) {
      // Каждая станция обязана НЕСТИ контрольную строку целиком…
      expect(text.includes(CONTROL), `записка потеряна на станции «${where}»`).toBe(true)
      // …и ни одна не имеет права подменить не-ASCII знаки вопросительными: ровно так
      // выглядела порча 01.09, и ровно это ни одно звено пути не делает.
      expect(text.includes('??????'), `станция «${where}» расплющила записку в ASCII`).toBe(false)
    }
  })
})
