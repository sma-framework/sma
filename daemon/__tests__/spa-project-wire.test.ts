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

    expect(seen).toEqual(['sma-dev'])
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
