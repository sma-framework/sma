/**
 * Tests for daemon/src/runner/redirects.mjs + the redirect door (the steering wheel).
 *
 * The law under test: a founder's correction to RUNNING work is durable BEFORE anything
 * is killed, has a declared fate (interrupt | queue | steer), is consumed exactly once, and a
 * torn or missing store loses corrections — never the tick. THREE fates, not two: the third is
 * a word for the turn already in flight, and it kills nobody.
 *
 *   Test 1 — append validates: a fate nobody declared, empty text, over-cap text refused;
 *            every declared fate passes.
 *   Test 2 — pending reads asks in order; done-marks consume exactly the named ids.
 *   Test 3 — a torn NDJSON line is skipped; the rest of the story still reads.
 *   Test 4 — the door: 501 without a store, 400s on bad body, 200 {accepted, live} on a
 *            good one; 'interrupt' pulls the registry trigger, 'queue' and 'steer' do not.
 *   Test 5 — THE WIRE, end to end through the PRODUCTION root: an answer sent from the
 *            window's conversation lands in the very store the tick reads before it resumes
 *            the session. Not the calculation — the wire.
 *   Test 6 — THE WIRE of the third fate: a line the store wrote is seen by the PATH-shaped
 *            reader the gate in the worker's child process calls live. The road, not the sums.
 *   Test 7 — the honest refusal: a task whose last attempt ran on a channel-less executor is
 *            told so, in words naming both shapes that DO reach it, and nothing is written;
 *            'interrupt' on the same task still answers 200 — the old fates are not collateral.
 *   Test 8 — no attempts yet, or a ledger that throws: the third fate is accepted and the line
 *            lies in the store. Silence is not evidence of a missing channel.
 *   Test 9 — one wording, two carriers: the heading correctionsPreamble mints is the literal
 *            the continuation loop already speaks. A lock against the two drifting apart.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  appendRedirect,
  readPendingRedirects,
  readPendingRedirectsFile,
  redirectFileOf,
  markConsumed,
  correctionsPreamble,
  REDIRECT_MODES,
  REDIRECT_TEXT_CAP,
} from '../src/runner/redirects.mjs'
import { createTurnRegistry } from '../src/front/chat.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { createDaemon } from '../src/main.mjs'

const TOKEN = 'r'.repeat(64)

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body } = o
  const payload = body == null ? [] : [Buffer.from(JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(code: number, h?: any) {
      res.statusCode = code
      if (h) Object.assign(res.headers, h)
      return res
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

describe('redirects store — durable, ordered, consumed once', () => {
  it('validates mode and text at the door of the file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-rd-'))
    expect(appendRedirect({ dataDir, taskId: 'T1', text: 'x', mode: 'shout' as any }).ok).toBe(false)
    expect(appendRedirect({ dataDir, taskId: 'T1', text: 'слово в ход', mode: 'steer' }).ok).toBe(true)
    expect(appendRedirect({ dataDir, taskId: 'T1', text: '   ', mode: 'queue' }).ok).toBe(false)
    expect(appendRedirect({ dataDir, taskId: 'T1', text: 'y'.repeat(REDIRECT_TEXT_CAP + 1), mode: 'queue' }).ok).toBe(false)
    expect(appendRedirect({ dataDir, taskId: 'T1', text: 'нет, не так', mode: 'interrupt' }).ok).toBe(true)
  })

  it('reads pending in order and consumes exactly the named ids', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-rd-'))
    const clock = () => 1_000
    const a = appendRedirect({ dataDir, taskId: 'T2', text: 'первая', mode: 'queue', clock })
    const b = appendRedirect({ dataDir, taskId: 'T2', text: 'вторая', mode: 'interrupt', clock })
    let pending = readPendingRedirects({ dataDir, taskId: 'T2' })
    expect(pending.map((p: any) => p.text)).toEqual(['первая', 'вторая'])

    markConsumed({ dataDir, taskId: 'T2', ids: [a.id!], clock })
    pending = readPendingRedirects({ dataDir, taskId: 'T2' })
    expect(pending.map((p: any) => p.id)).toEqual([b.id])

    markConsumed({ dataDir, taskId: 'T2', ids: [b.id!], clock })
    expect(readPendingRedirects({ dataDir, taskId: 'T2' })).toEqual([])
  })

  it('a torn line is skipped, the rest still reads; a foreign task reads empty', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-rd-'))
    mkdirSync(join(dataDir, 'redirects'), { recursive: true })
    writeFileSync(
      join(dataDir, 'redirects', 'T3.ndjson'),
      `${JSON.stringify({ kind: 'ask', id: 'rd-1', mode: 'queue', text: 'жива' })}\n{torn`,
      'utf8',
    )
    expect(readPendingRedirects({ dataDir, taskId: 'T3' }).map((p: any) => p.text)).toEqual(['жива'])
    expect(readPendingRedirects({ dataDir, taskId: 'T-nobody' })).toEqual([])
  })
})

describe('POST /api/redirect — the steering door', () => {
  it('501 without a store; 400s on bad body; durable write BEFORE the kill; interrupt pulls the trigger', async () => {
    const bare = createFrontServer({ config: { token: TOKEN }, deps: {} })
    const r501 = mkRes()
    await bare.handle(mkReq({ method: 'POST', url: '/api/redirect', body: { taskId: 'T4', text: 'x', mode: 'queue' } }), r501)
    expect(r501.statusCode).toBe(501)

    const dataDir = mkdtempSync(join(tmpdir(), 'sma-rd-'))
    const attemptTurns = createTurnRegistry()
    const front = createFrontServer({ config: { token: TOKEN, dataDir }, deps: { attemptTurns } })

    for (const bad of [
      { taskId: '../evil', text: 'x', mode: 'queue' },
      { taskId: 'T4', text: 'x', mode: 'shout' },
      { taskId: 'T4', text: '', mode: 'queue' },
      { taskId: 'T4', text: 'x', mode: 'queue', extra: 1 },
    ]) {
      const res = mkRes()
      await front.handle(mkReq({ method: 'POST', url: '/api/redirect', body: bad }), res)
      expect(res.statusCode, JSON.stringify(bad)).toBe(400)
    }

    // queue: written, nothing killed
    let killed = 0
    attemptTurns.register('T4', () => {
      killed += 1
    })
    const q = mkRes()
    await front.handle(mkReq({ method: 'POST', url: '/api/redirect', body: { taskId: 'T4', text: 'после хода', mode: 'queue' } }), q)
    expect(q.statusCode).toBe(200)
    expect(JSON.parse(q.body)).toMatchObject({ accepted: true, mode: 'queue', live: false })
    expect(killed).toBe(0)

    // interrupt: written, THEN the live child is told to die
    const i = mkRes()
    await front.handle(mkReq({ method: 'POST', url: '/api/redirect', body: { taskId: 'T4', text: 'перебей', mode: 'interrupt' } }), i)
    expect(i.statusCode).toBe(200)
    expect(JSON.parse(i.body)).toMatchObject({ accepted: true, mode: 'interrupt', live: true })
    expect(killed).toBe(1)

    // steer: a word for the turn in flight — written, and NOBODY is killed. This task has no
    // recorded attempts at all, so the door holds no evidence of a missing channel and takes
    // the line: it is durable, and the first turn that has a gate collects it.
    const s = mkRes()
    await front.handle(mkReq({ method: 'POST', url: '/api/redirect', body: { taskId: 'T4', text: 'слово в ход', mode: 'steer' } }), s)
    expect(s.statusCode).toBe(200)
    expect(JSON.parse(s.body)).toMatchObject({ accepted: true, mode: 'steer', live: false })
    expect(killed).toBe(1) // still ONE: the third fate shoots nobody, by construction

    // all three corrections are durable, in order, regardless of the kill
    const stored = readFileSync(join(dataDir, 'redirects', 'T4.ndjson'), 'utf8')
    expect(stored).toContain('после хода')
    expect(stored).toContain('перебей')
    expect(stored).toContain('слово в ход')
    expect(readPendingRedirects({ dataDir, taskId: 'T4' })).toHaveLength(3)
  })
})

/**
 * ОТВЕТ ИЗ ОКНА ДОЕЗЖАЕТ ДО ПРОДОЛЖЕНИЯ ТОЙ ЖЕ СЕССИИ — провод, а не вычисление.
 *
 * Обе половины дороги уже проверены по отдельности, и обе были зелёными в тот день, когда
 * дорога не работала: дверь пишет поправку в хранилище (тест 4), цикл читает хранилище и
 * продолжает сессию с `--resume` (сьют цикла). Между ними стоит третье утверждение, которое
 * ни один из тех тестов не делает: ЧТО ЭТО ОДНО И ТО ЖЕ ХРАНИЛИЩЕ. Каждый тест приносит свой
 * каталог и раздаёт его обеим сторонам сам — то есть проверяет дорогу, которую сам же и
 * построил, а не ту, по которой поедет ответ владельца.
 *
 * Здесь спрашивается сборка ПРОДУКТА: даётся один конфиг, дверь получает свой каталог от
 * корня, цикл — свой, и никто их не сводит руками. Поправка отправляется через настоящую
 * дверь и ищется тем самым чтением, которым цикл ищет её перед продолжением сессии. Разъедься
 * эти два каталога — дверь примет ответ, окно скажет «передал», а работник не увидит ни
 * слова: ровно тот класс, когда всё посчитано и ничто не соединено.
 *
 * Механизм коррекций этот тест не трогает: он ничего в нём не меняет и ни на что не влияет —
 * только смотрит, сходятся ли концы.
 */
describe('ответ из окна → канал продолжения той же сессии (провод сборки)', () => {
  it('дверь поправки пишет ровно в то хранилище, которое цикл читает перед продолжением', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sma-rd-wire-'))
    const repoDir = join(root, 'repo')
    mkdirSync(repoDir, { recursive: true })
    const configPath = join(root, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        // Закрытый порт: демон собирается, но не поднимается — очередь здесь не нужна вовсе.
        queueUrl: 'postgres://127.0.0.1:1/sma_none',
        bind: '127.0.0.1',
        port: 7998,
        token: TOKEN,
        repoDir,
        dataDir: join(root, 'data'),
        ledgerDir: join(root, 'ledger'),
      }),
      'utf8',
    )

    const saved = process.env.SMA_DAEMON_CONFIG
    const savedMcp = process.env.SMA_DAEMON_MCP
    process.env.SMA_DAEMON_CONFIG = configPath
    process.env.SMA_DAEMON_MCP = join(root, 'absent-mcp.json')

    let park: any
    try {
      // ПРОИЗВОДСТВЕННАЯ сборка, без единой подмены. Ничего не запускается: корень только вяжет.
      park = createDaemon()

      const res = mkRes()
      await park.front.handle(
        mkReq({
          method: 'POST',
          url: '/api/redirect',
          body: { taskId: 'W-1', text: 'блокировка в БД, продолжай ту же сессию', mode: 'queue' },
        }),
        res,
      )
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ accepted: true, mode: 'queue' })

      // Читаем ТЕМ ЖЕ каталогом, который корень отдал циклу, — не тем, что выбрал этот тест.
      const seenByTick = readPendingRedirects({
        dataDir: park.tickDeps.config.dataDir,
        taskId: 'W-1',
        fsImpl: park.tickDeps.fsImpl,
      })
      expect(seenByTick.map((r: any) => r.text)).toEqual(['блокировка в БД, продолжай ту же сессию'])
    } finally {
      try {
        if (park?.hub?.close) park.hub.close()
        if (park?.daemon?.stop) park.daemon.stop()
      } catch {
        /* best-effort */
      }
      if (saved === undefined) delete process.env.SMA_DAEMON_CONFIG
      else process.env.SMA_DAEMON_CONFIG = saved
      if (savedMcp === undefined) delete process.env.SMA_DAEMON_MCP
      else process.env.SMA_DAEMON_MCP = savedMcp
    }
  })
})

/**
 * ТРЕТЬЯ СУДЬБА — ПРОВОД, А НЕ ВЫЧИСЛЕНИЕ.
 *
 * Слово для идущего хода забирает не демон, а калитка ВНУТРИ дочернего процесса работника, и
 * держит она не каталог данных, а один путь, выданный ей в окружении. Значит у утверждения
 * «третья судьба работает» есть ровно один честный вид: строка, положенная хранилищем, видна
 * ТОЙ САМОЙ функции-по-пути, которую калитка зовёт живьём. Тест, спросивший вместо неё
 * удобного соседа по каталогу, проверил бы дорогу, которую сам же и построил.
 */
describe('слово идущему ходу доезжает до читателя в процессе работника (провод)', () => {
  it('строка третьей судьбы видна чтению-по-пути — тому, которым пользуется калитка', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-rd-live-'))
    const wrote = appendRedirect({ dataDir, taskId: 'live-1', text: 'сначала прочти соседний файл', mode: 'steer' })
    expect(wrote.ok).toBe(true)

    // Путь минтит САМ модуль — ровно так же, как его минтит демон перед запуском ребёнка.
    const file = redirectFileOf({ dataDir, taskId: 'live-1' })
    const seenByGate = readPendingRedirectsFile({ file })
    expect(seenByGate.map((r: any) => [r.mode, r.text])).toEqual([['steer', 'сначала прочти соседний файл']])

    // И судеб ровно три: список заморожен, четвёртой нет.
    expect([...REDIRECT_MODES]).toEqual(['interrupt', 'queue', 'steer'])
  })
})

/**
 * ГДЕ КАНАЛА НЕТ — ДВЕРЬ ГОВОРИТ ОБ ЭТОМ, А НЕ ПОДМЕНЯЕТ.
 *
 * Та же дверь честно работает как «убить и продолжить», и так она и подписана. Принять слово
 * для идущего хода у исполнителя, у которого границы вызова инструмента нет вовсе, и молча
 * доставить вместо него убийство — подлог: основатель увидел бы «передано» и получил бы
 * другую вещь. Подделка журнала читает АРГУМЕНТ и отвечает по нему; больше живого шва она не
 * умеет — настоящий отдаёт ровно массив строк попыток и ничего сверх.
 */
describe('исполнитель без живого канала — дверь подписана честно', () => {
  it('последняя попытка на лейне без калитки: отказ со словами и без записи; «перебить» по-прежнему 200', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-rd-nochan-'))
    const asked: string[] = []
    const ledger = {
      readAttempts: (id: string) => {
        asked.push(id)
        return id === 'nochan-1' ? [{ attempt: 1, provider: 'claude' }, { attempt: 2, provider: 'codex' }] : []
      },
    }
    const attemptTurns = createTurnRegistry()
    const front = createFrontServer({ config: { token: TOKEN, dataDir }, deps: { attemptTurns, ledger } })

    const no = mkRes()
    await front.handle(
      mkReq({ method: 'POST', url: '/api/redirect', body: { taskId: 'nochan-1', text: 'слово в ход', mode: 'steer' } }),
      no,
    )
    expect(no.statusCode).toBe(400)
    expect(asked).toContain('nochan-1')
    // ОБЕ доступные формы названы словами — иначе отказ не помогает, а только запрещает.
    expect(no.body).toContain('перебить')
    expect(no.body).toContain('после хода')

    // Отказ пришёл ДО записи: строки, которую никто не доставит, в хранилище нет.
    expect(readPendingRedirects({ dataDir, taskId: 'nochan-1' })).toEqual([])

    // Старые судьбы не задеты: та же задача, тот же журнал — «перебить» принимается и стреляет.
    let killed = 0
    attemptTurns.register('nochan-1', () => {
      killed += 1
    })
    const yes = mkRes()
    await front.handle(
      mkReq({ method: 'POST', url: '/api/redirect', body: { taskId: 'nochan-1', text: 'перебей', mode: 'interrupt' } }),
      yes,
    )
    expect(yes.statusCode).toBe(200)
    expect(JSON.parse(yes.body)).toMatchObject({ accepted: true, mode: 'interrupt', live: true })
    expect(killed).toBe(1)
    expect(readPendingRedirects({ dataDir, taskId: 'nochan-1' })).toHaveLength(1)
  })
})

/**
 * МОЛЧАНИЕ ЖУРНАЛА — НЕ ДОКАЗАТЕЛЬСТВО ОТСУТСТВИЯ КАНАЛА.
 *
 * Задача, которую ещё ни разу не брали, и журнал, который не читается, — разные беды, но обе
 * означают одно: дверь НЕ ЗНАЕТ, кто побежит. Строка долговечна, поэтому честный ход — принять
 * и ждать; уронить дверь из-за нечитаемого журнала было бы худшим из всех ответов.
 */
describe('задача без попыток и нечитаемый журнал — слово принимается и ждёт', () => {
  it('пустой журнал: 200 и строка в хранилище; журнал, который бросает: тоже 200', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-rd-fresh-'))
    const front = createFrontServer({ config: { token: TOKEN, dataDir }, deps: { ledger: () => [] } })
    const res = mkRes()
    await front.handle(
      mkReq({ method: 'POST', url: '/api/redirect', body: { taskId: 'fresh-1', text: 'начни с чтения', mode: 'steer' } }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ accepted: true, mode: 'steer', live: false })
    expect(readFileSync(join(dataDir, 'redirects', 'fresh-1.ndjson'), 'utf8')).toContain('начни с чтения')
    expect(readPendingRedirectsFile({ file: redirectFileOf({ dataDir, taskId: 'fresh-1' }) })).toHaveLength(1)

    const angry = createFrontServer({
      config: { token: TOKEN, dataDir },
      deps: {
        ledger: () => {
          throw new Error('журнал не читается')
        },
      },
    })
    const torn = mkRes()
    await angry.handle(
      mkReq({ method: 'POST', url: '/api/redirect', body: { taskId: 'torn-1', text: 'и это слово', mode: 'steer' } }),
      torn,
    )
    expect(torn.statusCode).toBe(200)
    expect(readPendingRedirects({ dataDir, taskId: 'torn-1' })).toHaveLength(1)
  })
})

/**
 * ОДНА ФОРМА СЛОВ, ДВА НОСИТЕЛЯ.
 *
 * Шапку поправки теперь несут двое: калитка в процессе работника и цикл продолжения. Пока
 * цикл не переведён на общего производителя, между ними стоит ровно этот замок — литерал
 * обязан присутствовать в исходнике цикла буква в букву. Разъедься формы, и основателя стали
 * бы цитировать по-разному в зависимости от того, какой дорогой поехало его предложение.
 */
describe('одна форма слов поправки, два носителя', () => {
  it('шапка производителя — тот самый литерал, которым цикл продолжения кормит возобновление', () => {
    const built = correctionsPreamble([{ text: 'первое' }, { text: 'второе' }])
    const heading = built.split('\n')[0]
    expect(built).toBe(`${heading}\n\nпервое\n\nвторое`)

    const loopSrc = readFileSync(new URL('../src/loop.mjs', import.meta.url), 'utf8')
    expect(loopSrc).toContain(heading)
  })
})
