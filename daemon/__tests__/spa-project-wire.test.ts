/**
 * ПРОВОДА ОКНА, А НЕ ВЫЧИСЛЕНИЯ.
 *
 * Дверь умела сузить чтение по проекту с того дня, как появилась (`?project=`), клиент умел
 * этот адрес построить — и не звал никто: чтение картины ходило `getState()` без единого
 * аргумента. Каждый кусок был написан, покрыт тестами и зелёный; ни один не был присоединён к
 * соседнему. Поэтому здесь проверяется не «функция считает правильно», а «значение доезжает»:
 *
 *   выбор у двери  → зеркало выбранного проекта
 *   зеркало        → аргумент чтения → адрес, который реально ушёл в сеть
 *   ответ двери    → зеркало (первичная засветка, пока человек ничего не переключал)
 *   удача выбора   → инвалидация ключа картины → чтение перезапрашивается
 *
 * Четвёртый провод проверяется прогоном именно потому, что читать `onSuccess` глазами —
 * не доказательство: обработчик перепишут, и окно снова начнёт врать до следующего опроса.
 *
 * DOM здесь не нужен: всё это — обычные функции над `fetch`, и `fetch` подменён.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import * as api from '../../spa/src/api/client'
import { selectedProject, setSelectedProject } from '../../spa/src/api/selected-project'
import { STATE_KEY, stateQueryFn, selectProjectAndRefresh } from '../../spa/src/api/queries'
import { splitByProject } from '../../spa/src/screens/tasks/units'

type Call = { url: string; method: string }

/** Ответ двери — ровно те поля, которые читают проверяемые провода. */
function stubFetch(body: unknown, ok = true): { calls: Call[] } {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    }),
  )
  return { calls }
}

beforeEach(() => {
  // зеркало — модульное состояние; каждый прогон начинается с «чем сузить, неизвестно»
  setSelectedProject(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setSelectedProject(null)
})

describe('выбранный проект доезжает до аргумента чтения', () => {
  it('чтение сужается тем проектом, который лежит в зеркале', async () => {
    const { calls } = stubFetch({ activeProject: 'sma-dev', queue: [], awaiting: [] })
    setSelectedProject('sma-dev')

    await stateQueryFn()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/state?project=sma-dev')
  })

  it('пустое зеркало — дверь спрашивают без сужения, а не проектом по умолчанию', async () => {
    const { calls } = stubFetch({ activeProject: null, queue: [], awaiting: [] })

    await stateQueryFn()

    expect(calls[0].url).toBe('/api/state')
  })

  it('первый ответ двери засвечивает зеркало её собственным выбором', async () => {
    stubFetch({ activeProject: 'sma', queue: [], awaiting: [] })
    expect(selectedProject()).toBeNull()

    await stateQueryFn()

    expect(selectedProject()).toBe('sma')
  })

  it('засветка не переставляет выбор человека задержавшимся ответом', async () => {
    stubFetch({ activeProject: 'sma', queue: [], awaiting: [] })
    setSelectedProject('sma-dev')

    await stateQueryFn()

    expect(selectedProject()).toBe('sma-dev')
  })
})

describe('выбор проекта доезжает от двери до зеркала', () => {
  it('удачный выбор записан туда, откуда читает чтение', async () => {
    const { calls } = stubFetch({ ok: true })

    await api.selectProject('sma-dev')

    expect(calls[0]).toEqual({ url: '/api/project/select', method: 'POST' })
    expect(selectedProject()).toBe('sma-dev')
  })

  it('отказ двери зеркало не трогает — иначе окно сузилось бы по непринятому выбору', async () => {
    stubFetch({ error: 'нет такого проекта' }, false)
    setSelectedProject('sma')

    await expect(api.selectProject('sma-dev')).rejects.toBeTruthy()

    expect(selectedProject()).toBe('sma')
  })
})

describe('четвёртый провод: после выбора картина перезапрашивается', () => {
  it('удачный выбор инвалидирует ключ состояния', async () => {
    stubFetch({ ok: true })
    const invalidated: unknown[] = []
    const queryClient = {
      invalidateQueries: (filters: { queryKey: unknown }) => {
        invalidated.push(filters.queryKey)
        return Promise.resolve()
      },
    }

    await selectProjectAndRefresh(queryClient, 'sma-dev')

    expect(invalidated).toContainEqual(STATE_KEY)
  })

  it('перезапрос заказан ПОСЛЕ того, как зеркало переставлено — иначе перечиталось бы старое сужение', async () => {
    stubFetch({ ok: true })
    const seen: (string | null)[] = []
    const queryClient = {
      invalidateQueries: () => {
        seen.push(selectedProject())
        return Promise.resolve()
      },
    }

    await selectProjectAndRefresh(queryClient, 'sma-dev')

    // Каждый заказанный перезапрос видит УЖЕ переставленное зеркало. Считать сами заказы
    // здесь нечего: их столько, сколько чтений зависит от проекта (картина, книга разговора),
    // и растёт этот список по мере того, как окно узнаёт о проекте новые места.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((p) => p === 'sma-dev')).toBe(true)
  })

  it('отказ двери перезапроса не заказывает', async () => {
    stubFetch({ error: 'нет такого проекта' }, false)
    let ordered = 0
    const queryClient = {
      invalidateQueries: () => {
        ordered += 1
        return Promise.resolve()
      },
    }

    await expect(selectProjectAndRefresh(queryClient, 'sma-dev')).rejects.toBeTruthy()

    expect(ordered).toBe(0)
  })
})

describe('строки с неизвестным проектом видны, а не спрятаны и не перекрашены', () => {
  const rows = [
    { id: 'a', project: 'sma' },
    { id: 'b', project: null },
    { id: 'c', project: 'sma-dev' },
    { id: 'd', project: null },
  ]

  it('при выбранном проекте свои — в списке, безымянные — отдельно, чужие — отброшены', () => {
    const { mine, unknown } = splitByProject(rows, 'sma')

    expect(mine.map((r) => r.id)).toEqual(['a'])
    expect(unknown.map((r) => r.id)).toEqual(['b', 'd'])
  })

  it('без выбранного проекта отличать нечего: всё в списке, безымянных нет', () => {
    const { mine, unknown } = splitByProject(rows, null)

    expect(mine.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(unknown).toEqual([])
  })

  it('неизвестное не приписано проекту: счёт своих его не раздувает', () => {
    const { mine, unknown } = splitByProject(rows, 'sma')

    expect(mine).toHaveLength(1)
    expect(unknown).toHaveLength(2)
    expect(mine.some((r) => r.project == null)).toBe(false)
  })

  it('строка не перекрашивается: у безымянной так и остаётся пустой проект', () => {
    const { unknown } = splitByProject(rows, 'sma')

    expect(unknown.every((r) => r.project == null)).toBe(true)
  })
})
