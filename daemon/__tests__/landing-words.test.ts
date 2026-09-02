/**
 * ПОКА ИДЁТ ПОСАДКА, КАРТОЧКА ГОВОРИТ «САЖАЮ», А НЕ «ПРИНЯТО».
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * За кнопкой приёмки стоит теперь не одно слияние, а посадка целиком: свод с вершиной, полный
 * прогон набора (когда квитанция работника это дерево уже не описывает) и штамп чисел. Это
 * минуты. Всё это время строка стояла со словом «принимается» — которое человек читает как
 * «принято», — а по концу не говорила НИЧЕГО: успех считался сказанным тем, что работа ушла
 * из «Ждут вашего решения». Пока за кнопкой было одно слияние, этого хватало; теперь за ней
 * стоит второе дело, и человек, переставший доводить числа руками, обязан УЗНАТЬ, что их
 * довели без него, — иначе он идёт проверять в терминал, то есть ровно туда, откуда его увели.
 *
 * ═══════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════
 *
 *   1. ПОКА ДВЕРЬ РАБОТАЕТ, строка стоит в состоянии посадки, и окно называет его словами
 *      «сажаю, идёт прогон» с оценкой времени. Утверждение делается НА ЖИВОЙ ДВЕРИ: ритуал
 *      задержан, и статус читается ровно в ту минуту, когда человек смотрит на экран.
 *   2. ИТОГ ПОСАДКИ ДОЕЗЖАЕТ ДО ОКНА — дверь кладёт его отдельным полем ответа, а не прячет
 *      внутри квитанции слияния, которую окно объявило непрозрачной.
 *   3. СЛОВА ИТОГА берутся из этого поля: зелёная вершина названа зелёной, незаштампованная —
 *      названа незаштампованной, а отказ по-прежнему говорит причиной двери.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: самой посадки — её разбор живёт над настоящими репозиториями
 * (`landing.test.ts`, `landing-wire.test.ts`). Здесь только путь от двери до глаз.
 */

import { Readable } from 'node:stream'

import { describe, it, expect } from 'vitest'

import { createFrontServer } from '../src/front/server.mjs'
import { deriveState } from '../src/front/state.mjs'
import { approvalOutcome, landingWords, statusWord, LANDING_RUN_ESTIMATE_MIN } from '../../spa/src/shell/format'

const TOKEN = 'test-token-value'
const NOW = 1_000_000_000_000

const config = { agingHours: 24, workers: [{ id: 'max-1', lane: 'prod', account: { name: 'max-1' } }] }
const win = (state: string) => ({ state, usedPct: null, resetAt: null })
const windows = () => ({ fiveHour: win('open'), week: win('open') })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function memoryQueue(initial: any[]) {
  const rows = initial.map((r) => ({ ...r }))
  return {
    rows,
    list: async () => rows.map((r) => ({ ...r })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exec: async (_sql: string, params: any[]) => {
      const to = params[0]
      const from = params[params.length - 1]
      const id = params[params.length - 2]
      const row = rows.find((r) => r.id === id)
      if (!row || row.status !== from) return { rows: [] }
      row.status = to
      return { rows: [{ id }] }
    },
  }
}

const awaitingRow = (id: string) => ({
  id,
  status: 'awaiting_approval',
  lane: 'prod',
  title: 'сделанная работа, которая ждёт вашего слова',
  attempt: 1,
  workerId: 'max-1',
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkReq(o: any = {}) {
  const { method = 'POST', url = '/', headers = {}, body } = o
  const payload = body == null ? [] : [Buffer.from(JSON.stringify(body))]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(code: number) {
      res.statusCode = code
      res.headersSent = true
      return res
    },
    setHeader() {},
    getHeader() {},
    write(c: unknown) {
      res.body += String(c)
      return true
    },
    end(c?: unknown) {
      if (c != null) res.body += String(c)
      return res
    },
  }
  return res
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function press(front: any, taskId: string) {
  const res = mkRes()
  const done = front.handle(
    mkReq({
      url: '/api/approve',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: { taskId },
    }),
    res,
  )
  return {
    res,
    settled: done.then(() => {
      try {
        return JSON.parse(res.body || '{}')
      } catch {
        return { said: res.body }
      }
    }),
  }
}

describe('пока идёт посадка, карточка говорит о посадке', () => {
  it('дверь держит строку в состоянии посадки, и окно называет это «сажаю, идёт прогон» с оценкой', async () => {
    const queue = memoryQueue([awaitingRow('R-1')])
    let release: (v: unknown) => void = () => {}
    const held = new Promise((r) => {
      release = r
    })
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: { list: queue.list },
        casExec: queue.exec,
        // Ритуал, задержанный ровно как настоящий полный прогон: пока он идёт, человек
        // смотрит на карточку, и вопрос «что она говорит» задаётся ИМЕННО СЕЙЧАС.
        verbRunner: async () => {
          await held
          return { merged: true, receipt: { branch: 'wt/R-1' }, landing: { stamped: true, committed: true, ran: true, tests: 6342, files: 287, badgeViolations: 0, numbersViolations: 0 } }
        },
      },
    })

    const flight = press(front, 'R-1')
    // Дать двери дойти до задержанного ритуала: до этого места она успевает сделать CAS.
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    const midRow = queue.rows.find((r) => r.id === 'R-1')
    expect(midRow?.status, 'дверь не отметила строку как идущую на посадку').toBe('approving')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mid = (await deriveState({
      adapter: { list: queue.list },
      ledger: () => [],
      windows,
      config,
      clock: () => NOW,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any
    const shown = mid.awaiting.find((r: any) => r.id === 'R-1')
    expect(shown, 'строка на посадке пропала с экрана — человеку не на что смотреть').toBeTruthy()

    // ── СЛОВА. Не «принято» и не «принимается»: действие в настоящем времени и его цена.
    expect(statusWord(shown.status)).toBe('сажаю, идёт прогон')
    expect(statusWord(shown.status)).not.toContain('принят')
    const hint = landingWords(shown.status)
    expect(hint, 'оценка времени не сказана — «нажалось и висит» неотличимо от работы').toBeTruthy()
    expect(hint).toContain(`${LANDING_RUN_ESTIMATE_MIN}`)
    expect(hint).toContain('мин')

    release(null)
    const out = await flight.settled
    expect(out.ok).toBe(true)
    // Строка ждущей быть перестала — иначе слово «сажаю» осталось бы на экране навсегда.
    expect(queue.rows.find((r) => r.id === 'R-1')?.status).toBe('approved')
    expect(landingWords(queue.rows.find((r) => r.id === 'R-1')?.status as any)).toBe(null)
  })

  it('итог посадки едет ОТДЕЛЬНЫМ полем ответа, и по нему окно говорит «main зелёный»', async () => {
    const queue = memoryQueue([awaitingRow('R-2')])
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: { list: queue.list },
        casExec: queue.exec,
        verbRunner: async () => ({
          merged: true,
          receipt: { branch: 'wt/R-2' },
          landing: { stamped: true, committed: true, ran: false, reusedReceipt: true, tests: 6342, files: 287, badgeViolations: 0, numbersViolations: 0 },
        }),
      },
    })

    const out = await press(front, 'R-2').settled
    expect(out.ok).toBe(true)
    expect(out.landing, 'дверь не донесла итог посадки до окна').toBeTruthy()
    expect(out.landing.stamped).toBe(true)

    const said = approvalOutcome(out)
    expect(said.ok).toBe(true)
    expect(said.text).toContain('main зелёный')
    expect(said.text).toContain('6342')
    expect(said.text, 'не сказано, что набор не гонялся второй раз — это и есть сэкономленные десять минут').toContain(
      'не гонялся заново',
    )
  })

  it('незаштампованная вершина названа незаштампованной, а не «принято»', async () => {
    const said = approvalOutcome({
      ok: true,
      landing: { stamped: false, reason: 'в сведённом дереве нет измеренной квитанции' },
    })
    expect(said.ok).toBe(false)
    expect(said.text).toContain('не проштампованы')
    expect(said.text).toContain('нет измеренной квитанции')
  })

  it('оставшиеся замечания сторожей названы числом — «зелёный» о них не говорят', () => {
    const said = approvalOutcome({
      ok: true,
      landing: { stamped: true, committed: true, ran: true, tests: 10, files: 2, badgeViolations: 1, numbersViolations: 2 },
    })
    expect(said.ok).toBe(false)
    expect(said.text).toContain('3')
    expect(said.text).not.toContain('зелёный')
  })

  it('отказ по-прежнему говорит причиной ДВЕРИ, а не сочинённой фразой окна', () => {
    const said = approvalOutcome({ ok: false, reason: 'в рабочем дереве есть несохранённые правки' })
    expect(said.ok).toBe(false)
    expect(said.text).toBe('в рабочем дереве есть несохранённые правки')
  })
})
