/**
 * ПРОВОДА ОКНА: РАЗГОВОР СТАНОВИТСЯ СВОИМ У КАЖДОГО ПРОЕКТА.
 *
 * Слово владельца: «разговор по разным проектам тоже разный должен быть». Половина решения
 * живёт за дверью и проверена там (`chat.test.ts`): ход записан вместе со своим проектом,
 * чтение по нему сужается, старый ход без проекта не подмешивается ни в одну нить. Здесь —
 * ВТОРАЯ половина, и она вся про провода, а не про вычисления:
 *
 *   зеркало выбранного проекта → аргумент чтения книги → адрес, который реально ушёл в сеть
 *   удача выбора проекта       → инвалидация ключа книги → книга перезапрашивается
 *   книга проекта              → нить, которую окно ПРОДОЛЖАЕТ (или новая, если её нет)
 *
 * Почему прогоном, а не чтением: каждый из трёх кусков по отдельности был бы написан и зелен,
 * а окно всё равно продолжало бы чужую беседу — ровно так этот дефект и жил. Правило выбора
 * нити поэтому вынесено из эффекта экрана в функцию (`screens/chat/thread.ts`): внутри эффекта
 * его нельзя прогнать, а прочитанное глазами уже однажды промолчало.
 *
 * DOM здесь не нужен: всё проверяемое — обычные функции над `fetch` и над списком ходов.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import * as api from '../../spa/src/api/client'
import { selectedProject, setSelectedProject } from '../../spa/src/api/selected-project'
import { CHAT_KEY, CHAT_LIST_KEY, STATE_KEY, chatHistoryQueryFn, selectProjectAndRefresh } from '../../spa/src/api/queries'
import { bookOf, threadOf } from '../../spa/src/screens/chat/thread'

type Call = { url: string; method: string }

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

/** Ход книги ровно в той форме, в какой его отдаёт дверь. */
function turn(project: string | null, conversationId: string, text: string) {
  return { ts: null, conversationId, project, role: 'user' as const, kind: null, text }
}

beforeEach(() => {
  setSelectedProject(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setSelectedProject(null)
})

describe('книга разговора спрашивается сужённой по выбранному проекту', () => {
  it('в адрес чтения уходит проект из зеркала', async () => {
    const { calls } = stubFetch({ turns: [] })
    setSelectedProject('sma-dev')

    await chatHistoryQueryFn()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/chat/history?project=sma-dev')
  })

  it('пустое зеркало — дверь спрашивают без сужения, а не проектом по умолчанию', async () => {
    const { calls } = stubFetch({ turns: [] })

    await chatHistoryQueryFn()

    expect(calls[0].url).toBe('/api/chat/history')
  })

  it('отправка хода проект НЕ несёт: его ставит дверь, а не окно', async () => {
    const { calls } = stubFetch({ conversationId: 'conv-1', kind: 'free', answer: { kind: 'text', text: 'ок' } })
    setSelectedProject('sma-dev')

    await api.sendChat({ text: 'привет' })

    expect(calls[0].url).toBe('/api/chat')
    expect(calls[0].url).not.toContain('project')
  })
})

describe('смена проекта перезапрашивает книгу разговора', () => {
  it('удачный выбор инвалидирует и картину, и книгу', async () => {
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
    expect(invalidated).toContainEqual(CHAT_KEY)
    // …и ОГЛАВЛЕНИЕ книги вместе с ней: у другого проекта другие беседы, и список слева
    // обязан смениться вместе с лентой, иначе окно предложит вернуться в чужой разговор
    expect(invalidated).toContainEqual(CHAT_LIST_KEY)
  })

  it('перезапрос заказан ПОСЛЕ того, как зеркало переставлено — иначе перечиталась бы чужая книга', async () => {
    stubFetch({ ok: true })
    const seen: (string | null)[] = []
    const queryClient = {
      invalidateQueries: () => {
        seen.push(selectedProject())
        return Promise.resolve()
      },
    }

    await selectProjectAndRefresh(queryClient, 'sma-dev')

    // по разу на каждый перезапрашиваемый ключ: картина, книга и её оглавление
    expect(seen).toEqual(['sma-dev', 'sma-dev', 'sma-dev'])
  })
})

describe('какую нить окно продолжает', () => {
  const book = [
    turn(null, 'conv-old', 'сказано до проектов'),
    turn('alpha', 'conv-a1', 'про альфу'),
    turn('beta', 'conv-b1', 'про бету'),
    turn('alpha', 'conv-a2', 'снова про альфу'),
  ]

  it('переключение проекта продолжает ДРУГУЮ нить, а не прежнюю', () => {
    expect(threadOf(bookOf(book, 'alpha'))).toBe('conv-a2')
    expect(threadOf(bookOf(book, 'beta'))).toBe('conv-b1')
  })

  it('у проекта, где разговора ещё не было, нити нет — следующий ход начинает новую', () => {
    expect(bookOf(book, 'gamma')).toEqual([])
    expect(threadOf(bookOf(book, 'gamma'))).toBeUndefined()
  })

  it('ход без проекта в проектную нить не попадает, но виден там, где сужать нечем', () => {
    expect(bookOf(book, 'alpha').some((t) => t.project === null)).toBe(false)
    expect(bookOf(book, null)).toHaveLength(4)
    expect(threadOf(bookOf(book, null))).toBe('conv-a2')
  })

  it('пустая книга — это «беседы нет», а не «беседа неизвестна»', () => {
    expect(threadOf([])).toBeUndefined()
    expect(threadOf(undefined)).toBeUndefined()
  })
})
