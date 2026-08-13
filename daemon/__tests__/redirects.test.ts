/**
 * Tests for daemon/src/runner/redirects.mjs + the redirect door (the steering wheel).
 *
 * The law under test: a founder's correction to RUNNING work is durable BEFORE anything
 * is killed, has a declared fate (interrupt | queue), is consumed exactly once, and a
 * torn or missing store loses corrections — never the tick.
 *
 *   Test 1 — append validates: mode outside the pair, empty text, over-cap text refused.
 *   Test 2 — pending reads asks in order; done-marks consume exactly the named ids.
 *   Test 3 — a torn NDJSON line is skipped; the rest of the story still reads.
 *   Test 4 — the door: 501 without a store, 400s on bad body, 200 {accepted, live} on a
 *            good one; 'interrupt' pulls the registry trigger, 'queue' does not.
 *   Test 5 — THE WIRE, end to end through the PRODUCTION root: an answer sent from the
 *            window's conversation lands in the very store the tick reads before it resumes
 *            the session. Not the calculation — the wire.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  appendRedirect,
  readPendingRedirects,
  markConsumed,
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
    expect(appendRedirect({ dataDir, taskId: 'T1', text: 'x', mode: 'steer' as any }).ok).toBe(false)
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
      { taskId: 'T4', text: 'x', mode: 'steer' },
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

    // both corrections are durable, in order, regardless of the kill
    const stored = readFileSync(join(dataDir, 'redirects', 'T4.ndjson'), 'utf8')
    expect(stored).toContain('после хода')
    expect(stored).toContain('перебей')
    expect(readPendingRedirects({ dataDir, taskId: 'T4' })).toHaveLength(2)
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
