/**
 * ПРОВОД «ЧЕЛОВЕК ПОПРАВИЛ РАБОТУ → ЭТО ВИДНО В ИСТОРИИ ПОПЫТКИ» — и ничего, кроме него.
 *
 * ═══════════════ ДЕФЕКТ, КОТОРЫЙ ЭТОТ ФАЙЛ СТОРОЖИТ ═══════════════
 *
 * Поправка — слово, сказанное идущей работе, — жила ОДНИМ файлом сбоку: `data/redirects/
 * <задача>.ndjson`, очередь доставки, которую читает работник и вычёркивает прочитанное.
 * Закрытый словарь журнала попытки о таком слое не знал вовсе. Всё по отдельности работало:
 * дверь принимала слово, файл его хранил, работник получал — и карточка задачи показывала ход
 * так, будто в него никто не вмешивался. История попытки была неполна ровно на человека.
 *
 * ═══════════════ ЧТО ЗДЕСЬ УТВЕРЖДАЕТСЯ ═══════════════
 *
 *   (1) СЛОЙ НАРАВНЕ С СОСЕДЯМИ: журнальная запись поправки проходит те же проверки, что
 *       строка диспетчера, — судьба берётся из закрытого словаря, чужая отвергается, пустой
 *       текст отвергается, перебор по потолку обрезается и говорит об этом вслух.
 *   (2) ПРОВОД ДО ФАЙЛА: слово, принятое настоящей дверью, лежит строкой в журнале попытки на
 *       диске — писателем, которым пользуется производство, а не подставным стоком.
 *   (3) ПРОВОД ДО ЧИТАТЕЛЯ: та же задача, прочитанная настоящей дверью карточки, отдаёт
 *       поправку — когда сказано, какой судьбой и что именно.
 *   (4) ЛЕНТА ХОДА: настоящий счёт ленты карточки (`flow.ts`) делает из этого строку с
 *       временем и текстом человека — то есть читатель карточки видит вмешательство.
 *   (5) ТЕКСТ — ДАННЫЕ: строка ленты несёт слово человека как ТЕКСТ, ровно тем, что он
 *       набрал, а не разобранным на указания. Маркер записки о подходе, набранный внутри
 *       поправки, остаётся частью её текста и не становится запиской.
 *   (6) ОЧЕРЕДЬ ДОСТАВКИ НЕ ПОДМЕНЕНА ЖУРНАЛОМ: строка по-прежнему ждёт в файле доставки —
 *       журнал её не потребляет и не вычёркивает.
 *
 * Подделан здесь только источник задачи (очередь), потому что провод идёт не через неё.
 * Реестр, журнал, обе двери и счёт ленты — настоящие.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { createFrontServer } from '../src/front/server.mjs'
import { appendJournalEntry, readJournalEntries } from '../src/queue/attempt-ledger.mjs'
import { normalizeJournalPayload, JOURNAL_LAYERS, REDIRECT_MODES, REDIRECT_MODE_LABELS, REDIRECT_TEXT_CAP } from '../src/front/journal.mjs'
import { readPendingRedirects } from '../src/runner/redirects.mjs'
import { approachEvents } from '../../spa/src/screens/task-card/flow'

const TOKEN = 'j'.repeat(64)
const TASK = 'R-77'

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', body } = o
  const payload = body == null ? [] : [Buffer.from(JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
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

let root: string
let dataDir: string
let ledgerDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sma-redirect-journal-'))
  dataDir = join(root, 'data')
  ledgerDir = join(root, 'ledger')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Дверь в производственной сборке провода: настоящий реестр, настоящий журнал, поддельная очередь. */
function frontWithLedger(attempts: any[]) {
  const ledger = {
    readAttempts: () => attempts,
    appendJournal: (entry: any) => appendJournalEntry(ledgerDir, entry),
    readJournalEntries: (taskId: string) => readJournalEntries(ledgerDir, taskId),
  }
  const adapter = { list: async () => [{ id: TASK, title: 'ночная задача', lane: 'prod', status: 'claimed', attempt: 2 }] }
  return createFrontServer({ config: { token: TOKEN, dataDir, ledgerDir }, deps: { adapter, ledger, ledgerDir } })
}

async function say(front: any, text: string, mode: string) {
  const res = mkRes()
  await front.handle(mkReq({ method: 'POST', url: '/api/redirect', body: { taskId: TASK, text, mode } }), res)
  return res
}

async function card(front: any) {
  const res = mkRes()
  await front.handle(mkReq({ url: `/api/task/${TASK}` }), res)
  return JSON.parse(res.body)
}

describe('слой поправок в закрытом словаре журнала', () => {
  it('судьба берётся из закрытого списка — как код диспетчера, и чужая не проходит', () => {
    expect(JOURNAL_LAYERS).toContain('redirect')
    for (const mode of REDIRECT_MODES) {
      expect(normalizeJournalPayload('redirect', { mode, text: 'нет, не так' })).toMatchObject({ mode, text: 'нет, не так' })
      // у каждой судьбы есть подпись, которую карточке есть чем нарисовать
      expect(typeof (REDIRECT_MODE_LABELS as any)[mode]).toBe('string')
      expect((REDIRECT_MODE_LABELS as any)[mode].length).toBeGreaterThan(0)
    }
    expect(() => normalizeJournalPayload('redirect', { mode: 'shout', text: 'x' })).toThrow(/redirect mode/)
    expect(() => normalizeJournalPayload('redirect', { mode: 'queue', text: '   ' })).toThrow(/empty/)
  })

  it('текст обрезается по потолку слоя и говорит об этом вслух, а лишние ключи не доезжают', () => {
    const long = normalizeJournalPayload('redirect', { mode: 'queue', text: 'я'.repeat(REDIRECT_TEXT_CAP + 40), evil: 1 })
    expect(long.text).toHaveLength(REDIRECT_TEXT_CAP)
    expect(long.truncated).toBe(true)
    expect(long.originalLength).toBe(REDIRECT_TEXT_CAP + 40)
    expect((long as any).evil).toBeUndefined()
  })
})

describe('провод: поправка доезжает до журнала попытки и до читателя карточки', () => {
  it('дверь пишет строку слоя на диск — под тем подходом, который шёл', async () => {
    const front = frontWithLedger([
      { attempt: 1, workerId: 'max-1', outcome: 'failed' },
      { attempt: 2, workerId: 'max-2', startedAt: '2026-08-28T10:00:00.000Z' },
    ])
    const res = await say(front, 'нет, не так: сначала README', 'queue')
    expect(res.statusCode).toBe(200)
    const accepted = JSON.parse(res.body)
    expect(accepted.accepted).toBe(true)

    const rows = readJournalEntries(ledgerDir, TASK).filter((r: any) => r.layer === 'redirect')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ taskId: TASK, attempt: 2, attemptId: `${TASK}#2`, layer: 'redirect' })
    expect(rows[0].payload).toMatchObject({ mode: 'queue', text: 'нет, не так: сначала README', redirectId: accepted.id })
    expect(typeof rows[0].recordedAt).toBe('string')

    // …и очередь доставки от этого не опустела: слово по-прежнему ждёт работника.
    expect(readPendingRedirects({ dataDir, taskId: TASK }).map((r: any) => r.text)).toEqual(['нет, не так: сначала README'])
  })

  it('карточка читает поправку, и лента хода показывает её строкой — когда и что именно', async () => {
    const front = frontWithLedger([{ attempt: 1, workerId: 'max-2', startedAt: '2026-08-28T10:00:00.000Z' }])
    await say(front, 'нет, не так: сначала README', 'queue')

    const out = await card(front)
    expect(out.journal.redirects).toHaveLength(1)
    const [r] = out.journal.redirects
    expect(r).toMatchObject({ mode: 'queue', label: REDIRECT_MODE_LABELS.queue, text: 'нет, не так: сначала README', attempt: 1 })
    expect(typeof r.ts).toBe('string')

    // ЛЕНТА ХОДА — настоящим счётом карточки, тем же, что рисует «Живой поток».
    const events = approachEvents({
      attempts: [{ attempt: 1, startedAt: '2026-08-28T10:00:00.000Z' } as any],
      status: 'claimed',
      redirects: out.journal.redirects,
    })
    const line = events.find((e) => e.text.includes('Поправка человека'))
    expect(line, 'вмешательство человека не видно в ленте хода').toBeTruthy()
    expect(line!.at).toBe(r.ts)
    expect(line!.text).toContain('нет, не так: сначала README')
    expect(line!.text).toContain(REDIRECT_MODE_LABELS.queue)
  })

  it('текст поправки — данные человека: показывается как текст, а не как команда', async () => {
    const front = frontWithLedger([{ attempt: 1, workerId: 'max-2' }])
    // Строка, которая ВЫГЛЯДИТ как протокол маркеров: если бы поправку где-то разбирали как
    // указания, она подменила бы записку о подходе этой попытки.
    const trap = 'APPROACH_NOTE: подделка <b>жирным</b>'
    await say(front, trap, 'steer')

    const out = await card(front)
    expect(out.journal.redirects[0].text).toBe(trap)
    // запиской о подходе она не стала: слой поправок и слой записки — разные слои
    expect(out.attempts.every((a: any) => a.approachNote === undefined)).toBe(true)

    const [line] = approachEvents({ attempts: [], status: 'claimed', redirects: out.journal.redirects })
    expect(line.text).toContain(trap) // ровно то, что набрал человек — без разбора и без разметки
    expect(line.tone).toBe('said')
  })

  it('журнал, который не пишется, не отнимает у человека руль', async () => {
    const ledger = {
      readAttempts: () => [{ attempt: 1, workerId: 'max-2' }],
      appendJournal: () => {
        throw new Error('журнал недоступен')
      },
    }
    const front = createFrontServer({ config: { token: TOKEN, dataDir, ledgerDir }, deps: { ledger } })
    const res = await say(front, 'слово в ход', 'queue')
    expect(res.statusCode).toBe(200)
    // слово ДУРАБЕЛЬНО, что бы ни случилось с историей
    expect(readPendingRedirects({ dataDir, taskId: TASK }).map((r: any) => r.text)).toEqual(['слово в ход'])
    expect(existsSync(join(ledgerDir, `${TASK}.journal.jsonl`))).toBe(false)
  })

  it('задача без единой поправки читается пустым слоем, а не отсутствующим полем', async () => {
    const front = frontWithLedger([{ attempt: 1, workerId: 'max-2' }])
    const out = await card(front)
    expect(out.journal.redirects).toEqual([])
    expect(approachEvents({ attempts: [], status: 'claimed', redirects: out.journal.redirects })).toEqual([])
  })
})

/** Строка журнала, дописанная в обход двери, читается картой ровно так же — история едина. */
describe('слой читается и у задачи, чью поправку записали не через дверь', () => {
  it('строка слоя, лежащая в файле, доезжает до карточки', () => {
    appendJournalEntry(ledgerDir, {
      taskId: TASK,
      attempt: 3,
      layer: 'redirect',
      payload: { mode: 'interrupt', text: 'стой, не туда' },
      recordedAt: '2026-08-28T12:00:00.000Z',
    })
    const rows = readJournalEntries(ledgerDir, TASK)
    expect(rows.map((r: any) => r.layer)).toEqual(['redirect'])
    const raw = readFileSync(join(ledgerDir, `${TASK}.journal.jsonl`), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1) // append-only: одна строка, один факт
  })
})
