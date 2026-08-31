/**
 * ОТКАЗ ПО ПОТОЛКУ ГОВОРИТ, ЧТО ИМЕННО НЕ ПОДОШЛО.
 *
 * ════════════════════ ЧТО ЭТО ЗА ДЕФЕКТ И ЧЕГО ОН СТОИЛ ════════════════════════
 * Замерено 31.08 на живой постановке: дверь слов задачи ответила отказом на описание длиной
 * ~2100 знаков при потолке 2000 — и в ответе не было НИ ОДНОГО из трёх чисел: ни имени поля,
 * ни фактической длины, ни самого потолка. Причину пришлось искать чтением исходников очереди.
 * Человек у окна в этом месте слеп полностью: форма просто не отправляется, и сказать ему
 * нечего. То же касалось остальных потолков — числа признаков успеха и снимка контекста.
 *
 * ════════════════════ ЧТО ЗДЕСЬ ЗАКРЫТО, В ЧЕТЫРЁХ ПРОВОДАХ ════════════════════
 *   1. ГЕЙТ говорит тремя числами — поле, факт, потолок — в каждом из трёх мест;
 *   2. ДВЕРЬ доносит эти слова телом отказа, а не глотает их (настоящий сервер, настоящая
 *      очередь): и дверь постановки, и дверь правки слов;
 *   3. ОКНО показывает сказанное дверью, а служебные строки по-прежнему прячет за общими
 *      словами — иначе человек читал бы потроха и считал их поломкой окна;
 *   4. ПОТОЛОК У ОКНА И У ОЧЕРЕДИ — ОДНО ЧИСЛО, и счётчик под полем не набран руками.
 *
 * ЧЕГО ЭТОТ ФАЙЛ НЕ УТВЕРЖДАЕТ. Он не заменяет живой прогон окна: как счётчик выглядит на
 * настоящем экране — вопрос к браузеру. Он закрывает то, что дешевле всего проглядеть: слова,
 * потерянные по дороге от гейта до глаз, и второй потолок, набранный в разметке.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CAP_ACCEPTANCE_ITEMS,
  CAP_TEXT,
  InvalidTaskError,
  TASK_CONTEXT_CAP,
  capRefusal,
  createMemoryQueue,
  validateTask,
  validateWords,
} from '../src/queue/adapter.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { ApiError } from '../../spa/src/api/client'
import { refusalWords } from '../../spa/src/shell/format'
import * as windowCaps from '../../spa/src/shell/caps'

const TOKEN = 'p'.repeat(64)
const NOW = 1_700_000_000_000
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

const task = (over: Record<string, unknown> = {}) => ({
  id: 'R-1',
  source: 'roster',
  title: 'починить импорт',
  lane: 'prod',
  ...over,
})

/** Сколько бы ни промахнулись — промах называется числом, а не словом «слишком». */
const OVER_TEXT = CAP_TEXT + 103 // 2103 — ровно та длина, на которой это и вскрылось
const OVER_CONTEXT = TASK_CONTEXT_CAP + 12

function mkReq(url: string, body?: unknown) {
  const req: any = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
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
    getHeader() {
      return undefined
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      return res
    },
  }
  return res
}

async function post(front: any, url: string, body: unknown) {
  const res = mkRes()
  await front.handle(mkReq(url, body), res)
  return res
}

function frontWith(adapter: any) {
  return createFrontServer({
    config: {
      token: TOKEN,
      workers: [{ id: 'w-1', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      projects: [],
      repoDir: '/repo',
      agingHours: 24,
      backlogScanMinutes: 60,
      pipeline: { enabled: true },
    },
    deps: { adapter, clock: () => NOW },
  })
}

// ═════════════════ 1 · ГЕЙТ НАЗЫВАЕТ ПОЛЕ, ФАКТ И ПОТОЛОК ══════════════════

describe('гейт очереди: отказ по потолку называет три вещи, а не одну', () => {
  it('описание — поле, фактическая длина и потолок', () => {
    expect(() => validateTask(task({ description: 'д'.repeat(OVER_TEXT) }))).toThrow(InvalidTaskError)
    expect(() => validateTask(task({ description: 'д'.repeat(OVER_TEXT) }))).toThrow(
      'описание: 2103 знака при потолке 2000',
    )
  })

  it('число признаков успеха — столько же прямоты, сколько у длины', () => {
    const many = Array.from({ length: CAP_ACCEPTANCE_ITEMS + 1 }, (_, i) => `признак ${i}`)
    expect(() => validateTask(task({ acceptance: many }))).toThrow('признаков успеха: 13 при потолке 12')
  })

  it('снимок контекста — свой потолок, и он назван своим именем', () => {
    expect(() => validateTask(task({ taskContext: 'к'.repeat(OVER_CONTEXT) }))).toThrow(
      'снимок контекста: 8012 знаков при потолке 8000',
    )
  })

  it('длинный пункт приёмки называет НОМЕР — иначе в списке из дюжины неизвестно, что резать', () => {
    const list = ['короткий', 'тоже короткий', 'д'.repeat(OVER_TEXT)]
    expect(() => validateTask(task({ acceptance: list }))).toThrow('признак успеха №3: 2103 знака при потолке 2000')
  })

  it('счёт троится по-русски: 1 знак, 2 знака, 5 знаков — а не «1 знаков»', () => {
    expect(capRefusal('описание', 2001, 2000)).toBe('описание: 2001 знак при потолке 2000')
    expect(capRefusal('описание', 2002, 2000)).toBe('описание: 2002 знака при потолке 2000')
    expect(capRefusal('описание', 2005, 2000)).toBe('описание: 2005 знаков при потолке 2000')
    expect(capRefusal('описание', 2011, 2000)).toBe('описание: 2011 знаков при потолке 2000')
  })

  it('дверь правки слов судится тем же гейтом — и НЕ проговаривается подставным номером задачи', () => {
    // validateWords гоняет гейт по задаче с идентификатором «words»; приехав в окно, он
    // читался бы как номер настоящей задачи, которого человек нигде не видел.
    let said = ''
    try {
      validateWords({ description: 'д'.repeat(OVER_TEXT) })
    } catch (err) {
      said = String((err as Error).message)
    }
    expect(said).toBe('описание: 2103 знака при потолке 2000')
    expect(said).not.toContain('words')
  })
})

// ═════════════════ 2 · ДВЕРЬ ОТДАЁТ ЭТИ СЛОВА, А НЕ ГОЛЫЙ ОТКАЗ ══════════════════

describe('двери задач: тело отказа несёт слова гейта', () => {
  it('постановка отвечает 400 и называет описание, его длину и потолок', async () => {
    const front = frontWith(createMemoryQueue({ clock: () => NOW }))
    const res = await post(front, '/api/enqueue', {
      title: 'починить импорт',
      lane: 'prod',
      description: 'д'.repeat(OVER_TEXT),
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toBe('описание: 2103 знака при потолке 2000')
  })

  it('постановка так же прямо отказывает по снимку контекста', async () => {
    const front = frontWith(createMemoryQueue({ clock: () => NOW }))
    const res = await post(front, '/api/enqueue', {
      title: 'починить импорт',
      lane: 'prod',
      taskContext: 'к'.repeat(OVER_CONTEXT),
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toBe('снимок контекста: 8012 знаков при потолке 8000')
  })

  it('дверь слов задачи называет число признаков — то самое место, где отказ был голым', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    await adapter.enqueue({ id: 'R-7', source: 'roster', title: 'работа', lane: 'prod' })
    const front = frontWith(adapter)

    const res = await post(front, '/api/task/words', {
      taskId: 'R-7',
      acceptance: Array.from({ length: CAP_ACCEPTANCE_ITEMS + 1 }, (_, i) => `признак ${i}`),
    })

    expect(res.statusCode).toBe(400)
    expect(res.body).toBe('признаков успеха: 13 при потолке 12')
    // отказ ничего не записал — слова задачи остались какими были
    const [row] = await adapter.list({})
    expect(row.acceptance).toBeUndefined()
  })

  it('дверь слов задачи называет и описание, и его длину', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    await adapter.enqueue({ id: 'R-8', source: 'roster', title: 'работа', lane: 'prod' })
    const front = frontWith(adapter)

    const res = await post(front, '/api/task/words', { taskId: 'R-8', description: 'д'.repeat(OVER_TEXT) })

    expect(res.statusCode).toBe(400)
    expect(res.body).toBe('описание: 2103 знака при потолке 2000')
  })
})

// ═════════════════ 3 · ОКНО ДОНОСИТ СКАЗАННОЕ, А ПОТРОХА ПРЯЧЕТ ══════════════════

describe('окно: слова двери доходят до глаз целиком', () => {
  it('отказ по потолку показывается человеку так, как его сказала дверь', () => {
    expect(refusalWords(new ApiError(400, 'описание: 2103 знака при потолке 2000'))).toBe(
      'описание: 2103 знака при потолке 2000',
    )
    expect(refusalWords(new ApiError(400, 'признаков успеха: 13 при потолке 12'))).toBe(
      'признаков успеха: 13 при потолке 12',
    )
  })

  it('служебная строка остаётся за общими словами — окно не пересказывает потроха', () => {
    for (const detail of ['invalid taskId', 'nothing to change', 'not found', '']) {
      expect(refusalWords(new ApiError(400, detail))).toBe('Не получилось отправить. Попробуйте ещё раз.')
    }
  })

  it('простыня режется — красная строка формы остаётся читаемой', () => {
    const long = `описание: ${'о'.repeat(400)}`
    const said = refusalWords(new ApiError(400, long))
    expect(said.length).toBeLessThanOrEqual(301)
    expect(said.endsWith('…')).toBe(true)
  })

  it('чужие рода отказов свои слова не потеряли', () => {
    expect(refusalWords(new ApiError(501, 'дверь ещё не заполнена'))).toBe('Это действие пока недоступно.')
    expect(refusalWords(new ApiError(409, 'работа кончилась'))).toBe('За эту задачу уже ответили с другой стороны.')
  })
})

// ═════════════════ 4 · ОДИН ПОТОЛОК, А НЕ ДВА ПОХОЖИХ ══════════════════

describe('счётчик в окне считает до ТОГО ЖЕ числа, что и гейт', () => {
  it('потолки окна и очереди — одна и та же тройка чисел', () => {
    expect(windowCaps.CAP_TEXT).toBe(CAP_TEXT)
    expect(windowCaps.CAP_ACCEPTANCE_ITEMS).toBe(CAP_ACCEPTANCE_ITEMS)
    expect(windowCaps.TASK_CONTEXT_CAP).toBe(TASK_CONTEXT_CAP)
  })

  const FORMS = [
    join('spa', 'src', 'screens', 'tasks', 'NewTaskForm.tsx'),
    join('spa', 'src', 'screens', 'task-card', 'index.tsx'),
  ]

  for (const form of FORMS) {
    const src = readFileSync(join(ROOT, form), 'utf8')

    it(`${form}: счётчик стоит и берёт число из общего места`, () => {
      expect(src).toMatch(/from '\.\.\/\.\.\/shell\/caps'/)
      expect(src).toMatch(/\{CAP_TEXT\}/)
      expect(src).toMatch(/\{CAP_ACCEPTANCE_ITEMS\}/)
    })

    it(`${form}: поле слов больше не режет текст молча`, () => {
      // Браузерный `maxLength` на описании — это стена без объяснения: вставленные 2103
      // знака превращались в 2000, и задача уезжала с обрезанной на середине мысли фразой.
      expect(src).not.toMatch(/maxLength=\{2000\}/)
      expect(src).not.toMatch(/maxLength=\{CAP_TEXT\}/)
    })
  }
})
