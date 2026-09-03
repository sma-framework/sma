/**
 * ПРИГОВОР ХОДУ, КОТОРЫЙ ЕЩЁ НЕ РОДИЛСЯ: КТО ЕГО ВЫНОСИТ И ЧТО ОН О СЕБЕ ГОВОРИТ.
 *
 * ═══════════════ ЧТО ЭТО ЗА МЕХАНИКА И ЗАЧЕМ ОНА ЗАВЕДЕНА ═══════════════════════════
 * Между решением очереди выдать задачу и первым кадром работника лежит провизия копии —
 * заметное время. Слово «остановите», сказанное внутри этого окна, убивало НИЧЕГО: строка
 * закрывалась, сессия стартовала следом и жила невидимой, не привязанная ни к одной карточке.
 * Поэтому остановка неизвестного хода запоминается на короткий названный срок и исполняется
 * первой же регистрацией под этим именем.
 *
 * ═══════════════ ЧЕМ ЭТА МЕХАНИКА БЫЛА ОПАСНА ══════════════════════════════════════
 * Приговор выносился из ЛЮБОГО зова «останови», а зовут его четыре двери, и три из них
 * означают совсем другое. Дверь поправки («перебить сейчас») обрывает ход, чтобы работа
 * поехала ДАЛЬШЕ с новым словом; строку она не закрывает. Поправка, сказанная задаче, которая
 * ещё не запущена, не убивала никого в ту секунду — и убивала её же следующий ЗАКОННЫЙ запуск
 * в течение двух минут. Молча: убийство при рождении не оставляло строки нигде.
 *
 * ЧТО ДОКАЗЫВАЕТСЯ ЗДЕСЬ — провод, а не наличие функций:
 * (1) дверь поправки приговора НЕ выносит: ход, родившийся после неё, живёт и работает;
 * (2) дверь снятия работы выносит его по-прежнему — паритет не потерян;
 * (3) исполненный приговор пишет строку в тот же журнал, каким о себе рассказывает демон;
 * (4) просроченные приговоры убираются сами, на каждой регистрации, — карта не растёт.
 *
 * Двери настоящие, реестр ручек настоящий; подделаны только запрос, ответ и работник.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { createTurnRegistry, STOP_BEFORE_START_TTL_MS } from '../src/front/chat.mjs'
import { createFrontServer } from '../src/front/server.mjs'

const TOKEN = 's'.repeat(64)

function mkReq(o: any = {}) {
  const payload = o.body == null ? [] : [Buffer.from(JSON.stringify(o.body))]
  const req: any = Readable.from(payload)
  req.method = o.method ?? 'POST'
  req.url = o.url ?? '/'
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '10.0.0.1' }
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

async function call(front: any, url: string, body: unknown) {
  const req = mkReq({ url, body })
  const res = mkRes()
  await front.handle(req, res)
  return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') }
}

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

/** Обе двери одного демона: поправка пишет на диск, снятие закрывает строку в очереди. */
function mkFront(turns: any, over: any = {}) {
  return createFrontServer({
    config: { token: TOKEN, dataDir: mkdtempSync(join(tmpdir(), 'sma-sentence-')) },
    deps: {
      adapter: { async cancelTask() { return true }, async list() { return [] } },
      ledger: { readAttempts: () => [] },
      attemptTurns: turns,
      sleep: async () => {},
      ...over,
    },
  })
}

describe('приговор выносит только та дверь, которая снимает работу', () => {
  it('поправка «перебить сейчас» не осуждает ход — незапущенная задача запускается как обычно', async () => {
    const turns = createTurnRegistry()
    const front = mkFront(turns)

    // Работа ещё не запущена: живой ручки под этим именем нет и убивать нечего.
    const res = await call(front, '/api/redirect', {
      taskId: 'R-1788000000011',
      text: 'учти новое требование',
      mode: 'interrupt',
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ accepted: true, live: false })

    // …и запуск, случившийся следом, — законный: поправка ехала ему, а не против него.
    let killed = false
    turns.register('R-1788000000011', () => (killed = true), () => !killed)

    expect(killed, 'поправка к работе не имеет права убить её же следующий запуск').toBe(false)
    expect(turns.has('R-1788000000011'), 'ход обязан остаться в реестре живых и работать').toBe(true)
  })

  it('а дверь снятия работы осуждает по-прежнему — паритет дверей не потерян', async () => {
    const turns = createTurnRegistry()
    const front = mkFront(turns)

    const res = await call(front, '/api/task/cancel', { taskId: 'R-1788000000012' })
    expect(res.body).toMatchObject({ cancelled: true, killed: false, attemptClosed: null })

    let killed = false
    turns.register('R-1788000000012', () => (killed = true), () => !killed)

    expect(killed, 'снятая строка не имеет права оставить за собой живую сессию').toBe(true)
    expect(turns.has('R-1788000000012'), 'приговорённый ход не остаётся в реестре живых').toBe(false)
  })

  it('и поправка не отменяет уже вынесенного приговора — снятая строка остаётся снятой', async () => {
    const turns = createTurnRegistry()
    const front = mkFront(turns)

    await call(front, '/api/task/cancel', { taskId: 'R-1788000000013' })
    await call(front, '/api/redirect', { taskId: 'R-1788000000013', text: 'ещё слово', mode: 'interrupt' })

    let killed = false
    turns.register('R-1788000000013', () => (killed = true), () => !killed)
    expect(killed, 'дверь поправки приговоров не выносит, но и не милует').toBe(true)
  })
})

describe('исполненный приговор называет себя', () => {
  it('убийство при рождении пишет строку в журнал демона — иначе работа не поехала молча', async () => {
    const said: any[] = []
    const turns = createTurnRegistry({ journal: (e: unknown) => said.push(e) })
    const front = mkFront(turns)

    await call(front, '/api/task/cancel', { taskId: 'R-1788000000014' })
    expect(said, 'пока хода нет, рассказывать не о чем').toEqual([])

    turns.register('R-1788000000014', () => {})

    const line = said.find((e) => e && e.type === 'turn.killed_at_birth')
    expect(line, 'ход, убитый при рождении, обязан оставить строку — иначе объяснить нечем').toBeTruthy()
    expect(line.turnId).toBe('R-1788000000014')
    expect(String(line.detail), 'строка обязана называть ПРИЧИНУ, а не только факт').toContain('по отмене')
  })

  it('а ход, родившийся без приговора, никакой строки не пишет', () => {
    const said: any[] = []
    const turns = createTurnRegistry({ journal: (e: unknown) => said.push(e) })
    turns.register('R-1788000000015', () => {})
    expect(said, 'обычная регистрация — не событие').toEqual([])
  })
})

describe('карта приговоров не растёт', () => {
  it('просроченные приговоры убираются на каждой регистрации, а не ждут чтения по своему имени', async () => {
    const c = mkClock()
    const turns = createTurnRegistry({ clock: c.clock })
    const front = mkFront(turns)

    // Две работы сняты в окне между захватом и запуском — и ни одна из них так и не стартовала.
    await call(front, '/api/task/cancel', { taskId: 'R-1788000000016' })
    await call(front, '/api/task/cancel', { taskId: 'R-1788000000017' })
    expect(turns.condemnedSize, 'оба приговора ждут своих ходов').toBe(2)

    c.advance(STOP_BEFORE_START_TTL_MS + 1000)

    // Регистрация СОВСЕМ ДРУГОГО хода: по своему имени просроченные записи не читаются никогда,
    // и до уборки они оставались в карте на всю жизнь демона.
    turns.register('R-1788000000018', () => {})

    expect(turns.condemnedSize, 'приговор, переживший свой срок, не имеет права занимать память').toBe(0)
    expect(turns.has('R-1788000000018'), 'а чужой ход уборкой не задет').toBe(true)
  })

  it('и живой приговор уборкой не задет — срок ему ещё не вышел', async () => {
    const c = mkClock()
    const turns = createTurnRegistry({ clock: c.clock })
    const front = mkFront(turns)

    await call(front, '/api/task/cancel', { taskId: 'R-1788000000019' })
    c.advance(1000)
    turns.register('R-1788000000020', () => {})

    expect(turns.condemnedSize, 'уборка убирает просроченное, а не всё подряд').toBe(1)

    let killed = false
    turns.register('R-1788000000019', () => (killed = true))
    expect(killed, 'приговор, чей срок не вышел, обязан исполниться').toBe(true)
  })
})
