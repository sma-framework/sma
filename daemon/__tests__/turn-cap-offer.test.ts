/**
 * КРАСНАЯ КАРТОЧКА, КОТОРАЯ ПРЕДЛАГАЕТ, — И ПРОВОД ЗА КАЖДЫМ ИЗ ТРЁХ ЕЁ ДЕЙСТВИЙ.
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * Работа, у которой кончились ходы, показывала человеку красный прямоугольник и ни одного
 * слова о том, что делать. За сутки так встало шесть работ, и каждый раз решение принималось в
 * терминале, разбором журнала попытки: сколько ходов сожжено и на что именно они ушли, экран не
 * говорил вовсе. А между тем ответ на вопрос «поднимать потолок или дробить работу» лежит ровно
 * в этой разбивке: в двух сгоревших попытках было 120 и 94 запуска оболочки против 30 и 39
 * правок — то есть не хватило не места, а сходимости доказательства.
 *
 * ═══════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════
 *
 *   1. ДВЕРЬ СОСТОЯНИЯ НЕСЁТ ПРЕДЛОЖЕНИЕ — три названных действия и числа под ними — и несёт
 *      его ТОЛЬКО там, где следующей попытки не будет. Над строкой, которую очередь и так
 *      выдаст снова, три кнопки были бы выбором, которого у человека не спрашивали.
 *   2. У КАЖДОГО НАЗВАННОГО ИМЕНИ ЕСТЬ ДЕЛО В ОКНЕ. Списки двери и окна сверяются между собой:
 *      кнопка, за которой ничего не произойдёт, хуже молчания.
 *   3. ЧИСЛА И РАЗБИВКА СТАНОВЯТСЯ СТРОКОЙ, а неизмеренное остаётся неизмеренным — ноль на
 *      экране читается как «ходов не потрачено», а это другое утверждение.
 *   4. ПРОВОД ПЕРВОГО ДЕЙСТВИЯ: нажатие «поднять потолок» доходит до аргументов СЛЕДУЮЩЕГО
 *      запуска. Утверждается именно провод — что работа возвращается в очередь ПОД ТЕМ ЖЕ
 *      номером и что запуск после этого идёт со строго бóльшим потолком. Арифметика подъёма
 *      здесь не проверяется: она разобрана в `turn-budget.test.ts`.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: как распознаётся упор в потолок (`loop.test.ts`) и как строка попытки
 * попадает в реестр (`journal.test.ts`). Здесь только разговор с человеком и путь от его пальца.
 */

import { Readable } from 'node:stream'

import { describe, it, expect } from 'vitest'

import { deriveState } from '../src/front/state.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { TURN_CAP_ACTIONS, AWAITS_A_PERSON, turnCapOffer } from '../src/queue/adapter.mjs'
import { burnedTurnCapsOf } from '../src/policy/turn-budget.mjs'
import { createBuildArgs } from '../src/runner/build-args.mjs'
import { actOf, actableActions, spentLine, spentOf } from '../../spa/src/screens/today/offer'

const NOW = 1_000_000_000_000
const TOKEN = 'test-token-value'

/** Разбивка сгоревшей попытки: запусков оболочки вчетверо больше, чем правок. */
const KINDS = { edits: 30, runs: 120, reads: 44, other: 6 }

const config = {
  agingHours: 24,
  workers: [{ id: 'max-1', lane: 'prod', account: { name: 'max-1' } }],
}

const win = (state: string) => ({ state, usedPct: null, resetAt: null })
const windows = () => ({ fiveHour: win('open'), week: win('open') })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkAdapter = (rows: any[]) => ({ list: async () => rows.slice() })

const failedRow = (id: string, reason: string) => ({
  id,
  status: 'failed',
  lane: 'prod',
  title: 'работа, которая не поместилась',
  failure_reason: reason,
  attempt: 1,
  completedAt: NOW,
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ledgerOf = (rows: Record<string, any[]>) => (id: string) => rows[id] ?? []

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const derive = async (rows: any[], ledger: any) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await deriveState({ adapter: mkAdapter(rows), ledger, windows, config, clock: () => NOW })) as any

describe('дверь состояния: предложение вместо приговора', () => {
  /**
   * ТРИ ДЕЙСТВИЯ — ЭТО ПОЛНЫЙ СПИСОК ТОГО, ЧТО МОЖНО СДЕЛАТЬ С РАБОТОЙ, КОТОРАЯ НЕ ВЛЕЗЛА:
   * дать ей больше места, сделать её меньше или признать, что она не нужна. Список, в котором
   * их два, молча прячет третий выход.
   */
  it('работа, упёршаяся в потолок, приносит человеку три названных действия', async () => {
    const payload = await derive(
      [failedRow('R-1', 'turns_exhausted')],
      ledgerOf({
        'R-1': [
          { taskId: 'R-1', attempt: 1, workerId: 'max-1', failureReason: 'turns_exhausted', turnCap: 160, turnsUsed: 160, turnKinds: KINDS },
        ],
      }),
    )
    const offer = payload.done[0].failed.offer

    expect(offer.actions.map((a: { id: string }) => a.id)).toEqual(['raise', 'split', 'cancel'])
    for (const a of offer.actions) {
      expect(a.label.length, a.id).toBeGreaterThan(0)
      expect(a.detail.length, a.id).toBeGreaterThan(0)
    }
  })

  it('число сожжённых ходов и разбивка по роду приезжают в дверь состояния вместе с действиями', async () => {
    const payload = await derive(
      [failedRow('R-1', 'turns_exhausted')],
      ledgerOf({
        'R-1': [
          { taskId: 'R-1', attempt: 1, workerId: 'max-1', failureReason: 'turns_exhausted', turnCap: 160, turnsUsed: 160, turnKinds: KINDS },
        ],
      }),
    )
    const failed = payload.done[0].failed

    expect(failed.offer.turnsBurned).toBe(160)
    expect(failed.offer.cap).toBe(160)
    expect(failed.offer.kinds).toEqual(KINDS)
    // Та же разбивка лежит и на строке расхода: предложение её ПЕРЕДАЁТ, а не считает заново.
    expect(failed.spent).toEqual({ cap: 160, used: 160, kinds: KINDS })
  })

  /**
   * ПРЕДЛОЖЕНИЕ — ТОЛЬКО ТАМ, ГДЕ ПОВТОРА НЕТ. У красных тестов следующая попытка есть, и её
   * делает очередь сама; три кнопки над такой строкой предлагали бы решать уже решённое. Развилка
   * не выводится по имени причины дважды — она спрашивается у того же списка, что и у тика.
   */
  it('красная строка, за которой стоит повтор, предложения не получает — но расход показывает', async () => {
    const payload = await derive(
      [failedRow('R-2', 'tests_red')],
      ledgerOf({
        'R-2': [
          { taskId: 'R-2', attempt: 1, workerId: 'max-1', failureReason: 'tests_red', turnCap: 160, turnsUsed: 91, turnKinds: KINDS },
        ],
      }),
    )
    const failed = payload.done[0].failed

    expect(failed.offer).toBeUndefined()
    expect(failed.spent).toEqual({ cap: 160, used: 91, kinds: KINDS })
    expect(AWAITS_A_PERSON).not.toContain('tests_red')
  })

  /**
   * ВЫБОР НЕ ЗАВИСИТ ОТ ТОГО, ИЗМЕРИЛИ ЛИ ХОДЫ. Старая строка реестра о ходах молчит — значит
   * молчат и числа, но три выхода у человека те же самые. Нули здесь были бы измерением,
   * которого никто не делал.
   */
  it('попытка, которая о ходах молчит, приносит действия без чисел — а не с нулями', async () => {
    const payload = await derive(
      [failedRow('R-3', 'turns_exhausted')],
      ledgerOf({ 'R-3': [{ taskId: 'R-3', attempt: 1, workerId: 'max-1', failureReason: 'turns_exhausted' }] }),
    )
    const failed = payload.done[0].failed

    expect(failed.spent).toBeNull()
    expect(failed.offer.turnsBurned).toBeNull()
    expect(failed.offer.cap).toBeNull()
    expect(failed.offer.kinds).toBeNull()
    expect(failed.offer.actions).toHaveLength(3)
  })

  it('предложение — чистая передача: ноль и мусор вместо числа читаются как «не мерили»', () => {
    const offer = turnCapOffer({ turnsBurned: 0, cap: Number.NaN, kinds: null })
    expect(offer.turnsBurned).toBeNull()
    expect(offer.cap).toBeNull()
  })
})

describe('окно знает, чем делается каждое предложенное имя', () => {
  /**
   * ДОГОВОР ДВУХ СТОРОН, СВЕРЕННЫЙ МЕЖДУ СОБОЙ. Дверь называет выбор, окно знает дело; кнопка,
   * имени которой окно не знает, обещает человеку выход и не даёт его. Оба списка читаются здесь
   * из своих файлов — переписанный от руки третий список разошёлся бы с обоими молча.
   */
  it('у каждого действия двери есть дело окна', () => {
    for (const a of TURN_CAP_ACTIONS) expect(actOf(a.id), a.id).not.toBeNull()
    expect(actableActions([...TURN_CAP_ACTIONS])).toHaveLength(TURN_CAP_ACTIONS.length)
  })

  it('три имени — три РАЗНЫХ дела: поставить снова, набрать состав, остановить насовсем', () => {
    expect(TURN_CAP_ACTIONS.map((a) => actOf(a.id))).toEqual(['requeue', 'compose', 'cancel'])
  })

  it('имя, которого окно не знает, кнопкой не становится', () => {
    expect(actOf('teleport')).toBeNull()
    expect(actableActions([{ id: 'teleport', label: 'Телепортировать', detail: 'никуда' }])).toEqual([])
  })
})

describe('строка о ходах — та, по которой человек выбирает', () => {
  it('называет и сожжённое из отпущенного, и разбивку по роду', () => {
    expect(spentLine({ cap: 160, used: 160, kinds: KINDS })).toBe(
      'сожжено 160 из 160 ходов · правок 30 · запусков 120 · чтений 44',
    )
  })

  it('молчит целиком, когда мерить нечем — прочерк был бы тем же «неизвестно», только длиннее', () => {
    expect(spentLine(null)).toBeNull()
    expect(spentLine({ cap: null, used: null, kinds: null })).toBeNull()
  })

  it('числа берутся у предложения, а без него — у последней попытки', () => {
    const offer = turnCapOffer({ turnsBurned: 160, cap: 160, kinds: KINDS })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(spentOf(offer as any, null)).toEqual({ cap: 160, used: 160, kinds: KINDS })
    expect(spentOf(null, { cap: 80, used: 44, kinds: null })).toEqual({ cap: 80, used: 44, kinds: null })
  })
})

// ── ПРОВОД: от нажатия до аргументов следующего запуска ────────────────────────────────────

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

/** Строка задачи в ОДНОМ состоянии; CAS выигрывает только из него — как и настоящая. */
function casFrom(status: string) {
  const state = { status, calls: 0 }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exec = async (_sql: string, params: any[]) => {
    state.calls += 1
    const to = params[0]
    const from = params[params.length - 1]
    if (state.status !== from) return { rows: [] }
    state.status = to
    return { rows: [{ id: params[params.length - 2] }] }
  }
  return Object.assign(exec, { state })
}

const claudeWorker = {
  id: 'max-1',
  lane: 'prod',
  provider: 'claude',
  enabled: true,
  account: {
    name: 'max-1',
    configDir: '/accounts/max-1',
    oauthTokenEnv: 'SMA_MAX_1_TOKEN',
    spendLogsDir: '/accounts/max-1/spend',
  },
}

// Зеркало личного слоя, которое сборщик читает перед запуском: ни один случай здесь не трогает
// настоящий домашний каталог.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingsFs: any = {
  readFileSync: (p: string) => {
    if (String(p).replace(/\\/g, '/').endsWith('settings.json')) return JSON.stringify({ disableClaudeAiConnectors: true })
    throw new Error(`ENOENT ${p}`)
  },
}

const capAt = (args: string[]) => {
  const i = args.indexOf('--max-turns')
  return i === -1 ? null : Number(args[i + 1])
}

describe('провод: нажатие «поднять потолок» доезжает до аргументов следующего запуска', () => {
  /**
   * ЧТО ИМЕННО ДЕЛАЕТ НАЖАТИЕ. Оно не правит никакого числа — оно ставит ТУ ЖЕ работу обратно в
   * очередь. Потолок поднимает реестр попыток: сгоревший записан на строке, и следующий запуск
   * обязан выдать строго больший. Поэтому номер задачи здесь несущий: работа, поставленная
   * заново под новым номером, начала бы со дна и упёрлась бы в ту же стену.
   */
  it('вставшая работа возвращается в очередь под ТЕМ ЖЕ номером, и следующий запуск идёт с бóльшим потолком', async () => {
    const burned = [
      { taskId: 'R-1', attempt: 1, workerId: 'max-1', failureReason: 'turns_exhausted', turnCap: 160, turnsUsed: 160, turnKinds: KINDS },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enqueued: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: {
          list: async () => [{ id: 'R-1', attempt: 1, status: 'failed', title: 'работа, которая не поместилась', source: 'roster' }],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          enqueue: async (t: any) => {
            enqueued.push(t)
            return { id: t.id }
          },
        },
        casExec: casFrom('failed'),
      },
    })

    const res = mkRes()
    await front.handle(
      mkReq({
        url: '/api/return',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: { taskId: 'R-1', note: '' },
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(enqueued[0]).toMatchObject({ id: 'R-1', source: 'return', attempt: 2 })
    // Имя работы едет с ней: строка, названная своим номером, — это карточка без названия.
    expect(enqueued[0].title).toBe('работа, которая не поместилась')

    // …и вот последний отрезок дороги: аргументы процесса, который эта строка поднимет.
    const build = createBuildArgs({
      config: { workers: [claudeWorker], pipeline: { enabled: true, maxTurns: 80 } },
      env: { SMA_MAX_1_TOKEN: 'oauth-token-value' },
      fsImpl: settingsFs,
    })
    const spec = build(
      { ...enqueued[0], lane: 'prod' },
      { workerId: 'max-1', provider: 'claude', model: null, effort: null, useApiFallback: false, reason: 'profile' },
      { burnedTurnCaps: burnedTurnCapsOf(burned) },
    )

    expect(capAt(spec.args)).toBeGreaterThan(160)
  })

  /**
   * «ПОВТОРИТЬ ТУ ЖЕ СТРОКУ» ЗНАЧИТ ТУ ЖЕ, А НЕ ЕЁ ОГРЫЗОК.
   *
   * Повторная постановка под тем же номером не дополняет запись, а ПЕРЕЗАПИСЫВАЕТ её целиком:
   * всё, чего дверь не назвала, задача теряет молча. Дверь называла имя, полосу, конверт и
   * заметку — и работа возвращалась в очередь БЕЗ обещания, БЕЗ описания и БЕЗ оценки. То
   * есть нажатие «поднять потолок» стирало ровно те поля, по которым потолок и считается, а
   * работник второй попытки получал задачу без условий приёмки.
   */
  it('повтор ставит ТУ ЖЕ строку: обещание, описание и оценка едут с ней, а не теряются', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enqueued: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: {
          list: async () => [
            {
              id: 'R-1',
              attempt: 1,
              status: 'failed',
              title: 'работа, которая не поместилась',
              source: 'roster',
              lane: 'prod',
              storyPoints: 5,
              description: 'что это за работа',
              acceptance: ['красный тест до кода', 'полный сьют зелёный', 'ветка сливается', 'живой прогон'],
            },
          ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          enqueue: async (t: any) => {
            enqueued.push(t)
            return { id: t.id }
          },
        },
        casExec: casFrom('failed'),
      },
    })

    const res = mkRes()
    await front.handle(
      mkReq({
        url: '/api/return',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: { taskId: 'R-1', note: '' },
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(enqueued[0].acceptance).toEqual([
      'красный тест до кода',
      'полный сьют зелёный',
      'ветка сливается',
      'живой прогон',
    ])
    expect(enqueued[0].description).toBe('что это за работа')
    expect(enqueued[0].storyPoints).toBe(5)
  })

  it('работа, которая ждёт приёмки, возвращается ровно одним переходом — второго записывающего нет', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enqueued: any[] = []
    const cas = casFrom('awaiting_approval')
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: {
          list: async () => [{ id: 'R-9', attempt: 2, status: 'awaiting_approval', title: 'сделанная работа', source: 'roster' }],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          enqueue: async (t: any) => {
            enqueued.push(t)
            return { id: t.id }
          },
        },
        casExec: cas,
      },
    })

    const res = mkRes()
    await front.handle(
      mkReq({
        url: '/api/return',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: { taskId: 'R-9', note: 'переделай вывод' },
      }),
      res,
    )

    expect(res.statusCode).toBe(200)
    expect(cas.state.calls).toBe(1)
    expect(enqueued[0]).toMatchObject({ id: 'R-9', note: 'переделай вывод', attempt: 3 })
  })

  it('строка, которую никто не отдавал человеку, обратно не ставится — ответ отказ, а не тихая постановка', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enqueued: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        adapter: {
          list: async () => [{ id: 'R-7', attempt: 1, status: 'claimed', title: 'идущая работа' }],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          enqueue: async (t: any) => {
            enqueued.push(t)
            return { id: t.id }
          },
        },
        casExec: casFrom('claimed'),
      },
    })

    const res = mkRes()
    await front.handle(
      mkReq({
        url: '/api/return',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: { taskId: 'R-7', note: '' },
      }),
      res,
    )

    expect(res.statusCode).toBe(409)
    expect(enqueued).toHaveLength(0)
  })
})
