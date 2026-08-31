/**
 * ФОРМА ОБЕЩАНИЯ НЕ ДОЛЖНА РЕШАТЬ, СКОЛЬКО РАБОТЕ ДАДУТ ХОДОВ.
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * Потолок ходов считается от размера работы, и один из трёх признаков размера — сколько
 * ПУНКТОВ обещано. Поле обещания принимает два вида: список признаков и одну строку. Строка
 * честно читалась как «список из одного» — и работа, чьё обещание человек написал строкой с
 * тире в начале каждой строчки, выходила ОДНОПУНКТОВОЙ, то есть мелкой, и получала базовые
 * ходы. Замерено на одном и том же тексте: строкой — «мелкая», 160; тем же текстом списком —
 * «крупная», 480. Механизм был исправен; его кормили формой, в которой размер не виден.
 *
 * Рядом стояла вторая половина той же беды: размер и потолок не показывались человеку НИГДЕ.
 * Число доезжало до командной строки работника и до строки реестра — и всё; ошибку формы
 * нечем было заметить до того, как работа сгорит.
 *
 * ═══════════════ ЧТО ЭТОТ ФАЙЛ УТВЕРЖДАЕТ ═══════════════
 *
 *   (1) ОДНО И ТО ЖЕ ОБЕЩАНИЕ, НАПИСАННОЕ ДВУМЯ СПОСОБАМИ, ДАЁТ ОДИН РАЗМЕР И ОДИН ПОТОЛОК.
 *       Это и есть жалоба, записанная числом.
 *   (2) СТРОКА РЕЖЕТСЯ ПО СВОЕЙ СОБСТВЕННОЙ РАЗМЕТКЕ, и только по ней: сплошной текст, в
 *       котором автор границ не ставил, остаётся ОДНИМ пунктом — резать его по точкам и
 *       запятым значило бы расставить границы, которых автор не ставил.
 *   (3) ДВЕРЬ И ОКНО ЧИТАЮТ ОБЕЩАНИЕ ОДИНАКОВО. Читающих троп две (одна в очереди, одна в
 *       окне), и разъехавшись они показали бы человеку не тот список, по которому работника
 *       судят.
 *   (4) КАРТОЧКА НАЗЫВАЕТ РАЗМЕР И ПОТОЛОК СЛОВАМИ — до запуска, а не после того, как ходы
 *       кончились.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: арифметики подъёма после сгоревшего потолка (`turn-budget.test.ts`) и
 * провода кнопки «поднять потолок» (`turn-cap-offer.test.ts`).
 */

import { Readable } from 'node:stream'

import { describe, it, expect } from 'vitest'

import { acceptanceItems } from '../src/queue/adapter.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { workSizeOf, taskTurnCap, TURN_SIZES, TURN_SIZE_LABELS } from '../src/policy/turn-budget.mjs'
import { acceptanceList } from '../../spa/src/shell/format'
import { turnPlanLine, turnPlanWhy } from '../../spa/src/screens/task-card/turn-plan'

const TOKEN = 'test-token-value'
const BASE = 160

/** Обещание из четырёх признаков — сначала списком, потом ТЕМ ЖЕ текстом одной строкой. */
const CRITERIA = [
  'красный тест написан до кода',
  'полный сьют продукта зелёный',
  'ветка сливается с вершиной main без конфликтов',
  'живой прогон окна, путь квитанции в отчёте',
]
const AS_LIST = CRITERIA
const AS_STRING = `признаки успеха:\n${CRITERIA.map((s) => `- ${s}`).join('\n')}`

const task = (acceptance: string | string[]) => ({
  id: 'R-1',
  source: 'roster',
  title: 'работа',
  lane: 'prod',
  acceptance,
})

// ═══════════ (1) ФОРМА НЕ РЕШАЕТ РАЗМЕР ═══════════════════════════════════════════════════

describe('размер работы читается по обещанию, а не по форме, в которой его записали', () => {
  it('одно и то же обещание строкой и списком даёт ОДИН размер и ОДИН потолок', () => {
    const asString = taskTurnCap({ base: BASE, task: task(AS_STRING) })
    const asList = taskTurnCap({ base: BASE, task: task(AS_LIST) })

    expect(asString.size).toBe(asList.size)
    expect(asString.cap).toBe(asList.cap)
    // И это именно «крупная»: четыре отдельных обещания, у каждого своя проверка.
    expect(asList.size).toBe('large')
    expect(asString.size).toBe('large')
  })

  it('пункты считаются по разметке автора: четыре тире — четыре признака, а не один', () => {
    expect(workSizeOf(task(AS_STRING)).signals.criteria).toBe(workSizeOf(task(AS_LIST)).signals.criteria + 1)
    // +1 — заголовок «признаки успеха:», который человек тоже написал: терять его молча
    // нельзя, а объявлять его признаком честнее, чем выкидывать текст из обещания.
    expect(acceptanceItems(AS_STRING)).toEqual(['признаки успеха:', ...CRITERIA])
  })
})

// ═══════════ (2) РЕЖЕТСЯ ТОЛЬКО ТО, ЧТО РАЗМЕЧЕНО ═════════════════════════════════════════

describe('строка обещания режется по своей собственной разметке — и ни по чему больше', () => {
  it('сплошной текст остаётся ОДНИМ пунктом, со своими переносами', () => {
    const prose = 'тесты зелёные.\nи ещё окно открыто живьём, путь квитанции в отчёте'
    expect(acceptanceItems(prose)).toEqual([prose])
  })

  it('однострочное обещание — по-прежнему один пункт, слово в слово', () => {
    expect(acceptanceItems('тест зелёный')).toEqual(['тест зелёный'])
    expect(acceptanceItems('   ')).toEqual([])
    expect(acceptanceItems(null)).toEqual([])
  })

  it('маркеры узнаются те, какими люди и пишут: тире, звёздочка, точка, номер', () => {
    expect(acceptanceItems('- раз\n- два')).toEqual(['раз', 'два'])
    expect(acceptanceItems('* раз\n* два')).toEqual(['раз', 'два'])
    expect(acceptanceItems('• раз\n• два')).toEqual(['раз', 'два'])
    expect(acceptanceItems('1. раз\n2. два')).toEqual(['раз', 'два'])
    expect(acceptanceItems('1) раз\n2) два')).toEqual(['раз', 'два'])
  })

  it('продолжение пункта остаётся при своём пункте, а не заводит новый', () => {
    expect(acceptanceItems('- раз,\n  и его продолжение\n- два')).toEqual(['раз, и его продолжение', 'два'])
  })

  it('тире в середине строки пунктом не становится — режется только начало строки', () => {
    expect(acceptanceItems('тест зелёный - и быстрый')).toEqual(['тест зелёный - и быстрый'])
  })

  it('список остаётся списком: у него границы уже расставлены', () => {
    expect(acceptanceItems(['раз', '  два  ', '', 'три'])).toEqual(['раз', 'два', 'три'])
  })
})

// ═══════════ (3) ДВЕРЬ И ОКНО ЧИТАЮТ ОДНО И ТО ЖЕ ═════════════════════════════════════════

describe('читающая тропа очереди и читающая тропа окна отвечают ОДНО И ТО ЖЕ', () => {
  it('на всяком виде обещания оба списка совпадают пункт в пункт', () => {
    const shapes: (string | string[] | null)[] = [
      AS_STRING,
      AS_LIST,
      'тест зелёный',
      '- раз\n- два\n- три',
      '1. раз\n2. два',
      'сплошной текст.\nв две строки',
      '',
      null,
    ]
    for (const shape of shapes) {
      expect(acceptanceList(shape)).toEqual(acceptanceItems(shape))
    }
  })
})

// ═══════════ (4) РАЗМЕР ВИДЕН ЧЕЛОВЕКУ ════════════════════════════════════════════════════

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body, remote = '10.0.0.9' } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { ...headers }
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
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

async function cardOf({ row, attempts = [] as any[] }: any) {
  const front = createFrontServer({
    config: { token: TOKEN, pipeline: { maxTurns: BASE } },
    deps: {
      adapter: { list: async () => [row] },
      ledger: {
        readAttempts: () => attempts,
        readAttemptLog: () => ({ entries: [], truncated: false, roles: [], rolesMore: 0, digest: null }),
        readJournalEntries: () => [],
      },
    },
  })
  const res = mkRes()
  await front.handle(mkReq({ url: `/api/task/${row.id}`, headers: { authorization: `Bearer ${TOKEN}` } }), res)
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body).task
}

describe('карточка задачи называет размер работы и потолок ходов ДО запуска', () => {
  it('крупная работа названа крупной, и её потолок назван числом', async () => {
    const card = await cardOf({
      row: { id: 'R-1', status: 'queued', lane: 'prod', title: 'работа', attempt: 1, priority: 0, acceptance: AS_LIST },
    })

    expect(card.turnPlan).toMatchObject({ size: 'large', sizeLabel: 'крупная', cap: BASE * 3 })
    expect(card.turnPlan.signals).toMatchObject({ criteria: 4 })
  })

  it('обещание, написанное строкой, читается на карточке ТЕМ ЖЕ размером', async () => {
    const card = await cardOf({
      row: { id: 'R-1', status: 'queued', lane: 'prod', title: 'работа', attempt: 1, priority: 0, acceptance: AS_STRING },
    })
    expect(card.turnPlan.size).toBe('large')
    expect(card.turnPlan.cap).toBe(BASE * 3)
  })

  it('после сгоревшего потолка карточка называет ПОДНЯТОЕ число, а не то, что было', async () => {
    const card = await cardOf({
      row: { id: 'R-1', status: 'failed', lane: 'prod', title: 'работа', attempt: 1, priority: 0, acceptance: 'тест зелёный' },
      attempts: [{ attempt: 1, failureReason: 'turns_exhausted', turnCap: BASE }],
    })
    expect(card.turnPlan.escalatedFrom).toBe(BASE)
    expect(card.turnPlan.cap).toBe(BASE * 2)
  })

  it('работа, которой честного потолка больше нет, говорит об этом пустотой, а не нулём', async () => {
    const card = await cardOf({
      row: { id: 'R-1', status: 'failed', lane: 'prod', title: 'работа', attempt: 3, priority: 0, acceptance: AS_LIST },
      attempts: [{ attempt: 3, failureReason: 'turns_exhausted', turnCap: BASE * 6 }],
    })
    expect(card.turnPlan.cap).toBeNull()
    expect(card.turnPlan.ceiling).toBe(BASE * 6)
  })
})

describe('слова размера — один словарь на дверь и окно', () => {
  it('у каждого размера есть своё слово, и лишних слов нет', () => {
    expect(Object.keys(TURN_SIZE_LABELS).sort()).toEqual([...TURN_SIZES].sort())
    for (const size of TURN_SIZES) expect(typeof TURN_SIZE_LABELS[size]).toBe('string')
  })

  it('окно рисует строку из того, что приехало, и молчит, когда мерить нечем', () => {
    expect(turnPlanLine({ size: 'large', sizeLabel: 'крупная', cap: 480, ceiling: 960, escalatedFrom: null, signals: null } as any)).toBe(
      'крупная · потолок 480 ходов',
    )
    expect(turnPlanLine({ size: 'small', sizeLabel: 'мелкая', cap: null, ceiling: 960, escalatedFrom: 960, signals: null } as any)).toBe(
      'мелкая · честного потолка больше нет',
    )
    expect(turnPlanLine(null)).toBeNull()
    expect(turnPlanWhy(null)).toBeNull()
  })

  it('по каким признакам размер получился таким — сказано, чтобы потолок не читался произволом', () => {
    const why = turnPlanWhy({
      size: 'large',
      sizeLabel: 'крупная',
      cap: 480,
      ceiling: 960,
      escalatedFrom: null,
      signals: { storyPoints: null, criteria: 4, promiseChars: 135 },
    } as any)
    expect(why).toContain('4')
    expect(why).toContain('135')
  })
})
