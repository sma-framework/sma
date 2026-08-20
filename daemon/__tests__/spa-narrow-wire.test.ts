/**
 * ПРОВОДА УЗКОЙ ПОЛОСЫ, А НЕ ЕЁ ВЫЧИСЛЕНИЯ.
 *
 * Узкая полоса — отдельная работа со своим составом, и у неё ровно три места, где кусок должен
 * быть ПРИСОЕДИНЁН к соседу, а не просто написан рядом с ним:
 *
 *   состав   → каждый экран окна классифицирован: узкий он или столу (без «забыли этот»);
 *   порог    → одно число в модуле узкой работы и литерал минимума на раме — сверены машиной;
 *   приёмка  → кнопка телефона едет ТОЙ ЖЕ дверью и ТЕМ ЖЕ хуком, что кнопка стола.
 *
 * Каждый из трёх раньше уже ломался в этом окне тем самым способом: кусок был написан, покрыт
 * тестами и зелёный — и не присоединён к соседнему. Поэтому здесь проверяется «значение
 * доезжает», а не «функция считает правильно».
 *
 * ДОСТУПНОСТЬ ЗДЕСЬ — ТОЖЕ ПРОВОД, и утверждается прогоном, а не прозой: на телефоне размер
 * цели, размер текста и досягаемость с клавиатуры решают, работает вещь или нет. Каждая
 * проверка разметки сделана отдельной чистой функцией, и у каждой есть случай на ПОДДЕЛЬНОМ
 * плохом исходнике — иначе проверка, чей поиск ничего не нашёл, была бы зелёной ровно потому,
 * что ничего не искала.
 *
 * DOM не нужен: состав и порог — обычные значения, дверь проверяется подменой сетевого вызова,
 * разметка читается как текст.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect, afterEach, vi } from 'vitest'

import * as api from '../../spa/src/api/client'
import { SCREENS } from '../../spa/src/screens/registry'
import {
  NARROW_CAPABLE,
  TAP_MIN_PX,
  TEXT_MIN_PX,
  WIDE_MIN_PX,
  isNarrowCapable,
  wideMediaQuery,
} from '../../spa/src/shell/narrow/narrow'

const NARROW_DIR = fileURLToPath(new URL('../../spa/src/shell/narrow/', import.meta.url))

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** Все файлы разметки узкой полосы — по каталогу, а не списком: следующая часть попадёт сюда сама. */
function narrowMarkupFiles(): { name: string; src: string }[] {
  return readdirSync(NARROW_DIR)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => ({ name, src: readFileSync(NARROW_DIR + name, 'utf8') }))
}

/**
 * Открывающие теги данного имени — целиком, вместе с атрибутами.
 *
 * Границей тега считается `>` ВНЕ фигурных скобок: стрелка обработчика (`() => …`) живёт
 * внутри них, и наивный поиск первого `>` резал бы тег ровно по ней.
 */
function openingTags(src: string, name: string): string[] {
  const out: string[] = []
  const open = `<${name}`
  let i = src.indexOf(open)
  while (i !== -1) {
    let depth = 0
    let j = i + open.length
    for (; j < src.length; j += 1) {
      const c = src[j]
      if (c === '{') depth += 1
      else if (c === '}') depth -= 1
      else if (c === '>' && depth === 0) break
    }
    out.push(src.slice(i, j + 1))
    i = src.indexOf(open, j)
  }
  return out
}

/** На чём висят обработчики нажатия. Всё, что не `button`, — до этого не добраться с клавиатуры. */
function clickableTagNames(src: string): string[] {
  const names: string[] = []
  const re = /onClick=/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const tag = /<([A-Za-z][\w.]*)[^<]*$/.exec(src.slice(0, m.index))
    names.push(tag ? tag[1] : '(обработчик вне тега)')
  }
  return names
}

/** Кнопки без заявленной минимальной высоты цели — то есть без пола попадания пальцем. */
function buttonsWithoutTapFloor(src: string, minPx: number): string[] {
  return openingTags(src, 'button').filter((tag) => !tag.includes(`min-h-[${minPx}px]`))
}

/** Кнопки без видимой рамки фокуса: клавиатура доводит до них, но не показывает, где она. */
function buttonsWithoutFocusRing(src: string): string[] {
  return openingTags(src, 'button').filter((tag) => !tag.includes('focus-visible:outline'))
}

/** Самый мелкий размер текста, заявленный в разметке. `null` — размеров не заявлено вовсе. */
function smallestTextPx(src: string): number | null {
  const found = [...src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]))
  return found.length > 0 ? Math.min(...found) : null
}

/**
 * Слои-диалоги без `aria-modal`: шторка, накрывшая экран, обязана сказать читающему с экрана,
 * что за ней ничего не осталось, — иначе он продолжит читать спрятанное под ней.
 */
function dialogsWithoutAriaModal(src: string): string[] {
  return openingTags(src, 'aside')
    .concat(openingTags(src, 'div'), openingTags(src, 'nav'), openingTags(src, 'section'))
    .filter((tag) => /role="dialog"/.test(tag) && !tag.includes('aria-modal'))
}

type Call = { url: string; method: string; body: string }

/** Дверь, отвечающая ровно тем, что читают проверяемые провода. */
function stubFetch(body: unknown, ok = true): { calls: Call[] } {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('состав узкой полосы объявлен целиком, а не «что успели»', () => {
  it('узкая полоса умеет ровно объявленное — задачи и всё, что из них растёт', () => {
    expect([...NARROW_CAPABLE]).toEqual(['tasks'])
  })

  it('классифицирован КАЖДЫЙ экран окна: узких — ровно один, остальные честно отданы столу', () => {
    expect(SCREENS.length).toBeGreaterThan(0)

    const narrow = SCREENS.filter((s) => isNarrowCapable(s.id)).map((s) => s.id)
    const wide = SCREENS.filter((s) => !isNarrowCapable(s.id)).map((s) => s.id)

    expect(narrow).toEqual(['tasks'])
    expect(narrow.length + wide.length).toBe(SCREENS.length)
    expect(wide).toContain('memory')
    expect(wide).toContain('machines')
  })

  it('объявленный состав — не пустое множество: телефон умеет хотя бы одно дело целиком', () => {
    expect(NARROW_CAPABLE.size).toBe(1)
    expect(isNarrowCapable('tasks')).toBe(true)
    expect(isNarrowCapable('today')).toBe(false)
  })
})

describe('порог узости — одно число, и рама сверена с ним машиной', () => {
  it('порог назван числом', () => {
    expect(WIDE_MIN_PX).toBe(1360)
  })

  it('медиа-запрос построен ИЗ константы, а не написан рядом с ней вторым числом', () => {
    expect(wideMediaQuery()).toBe(`(min-width: ${WIDE_MIN_PX}px)`)
    expect(wideMediaQuery()).toContain('1360')
  })

  it('литерал минимальной ширины на раме окна — то же самое число', () => {
    const shell = readSource('../../spa/src/shell/Shell.tsx')

    expect(shell).toContain(`min-w-[${WIDE_MIN_PX}px]`)

    // Второго минимума на раме нет: два числа в одном месте разошлись бы в первый же день.
    const minimums = [...shell.matchAll(/min-w-\[(\d+)px\]/g)].map((m) => Number(m[1]))
    expect(minimums).toEqual([WIDE_MIN_PX])
  })
})

describe('приёмка на телефоне едет той же дверью, что приёмка на столе', () => {
  it('общий слой окна стучится в дверь одобрения именно этой задачей', async () => {
    const { calls } = stubFetch({ ok: true, taskId: 'T-1', merged: true })

    await api.approve('T-1', {})

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('/api/approve')
    expect(JSON.parse(calls[0].body)).toEqual({ taskId: 'T-1' })
  })

  it('узкая карточка держится за ОБЩИЙ хук приёмки, а не за свой', () => {
    const card = readSource('../../spa/src/shell/narrow/NarrowTaskCard.tsx')

    expect(card).toMatch(/import\s*\{[^}]*useApprove[^}]*\}\s*from\s*'\.\.\/\.\.\/api\/queries'/)
    expect(card).toContain('approve.mutate')
  })

  it('широкая панель держится за ТОТ ЖЕ хук — путь приёмки у обеих ширин один', () => {
    const panel = readSource('../../spa/src/shell/TaskPanel.tsx')

    expect(panel).toMatch(/import\s*\{[^}]*useApprove[^}]*\}\s*from\s*'\.\.\/api\/queries'/)
  })

  it('своего пути к двери у узкой полосы нет ни одного', () => {
    for (const file of narrowMarkupFiles()) {
      expect(file.src, `${file.name} обращается в сеть сам`).not.toContain('fetch')
      // Ищется АДРЕС ДВЕРИ строкой (`'/api/…'`), а не подстрока пути: общий слой окна лежит в
      // соседней папке, и его ввоз пишется как `'../../api/queries'` — это не второй путь к двери.
      expect(file.src, `${file.name} называет адрес двери сам`).not.toMatch(/['"`]\/api\//)
    }
  })

  it('быстрой приёмки на телефоне нет: отказ двери показывается словами, а не проглатывается', () => {
    const card = readSource('../../spa/src/shell/narrow/NarrowTaskCard.tsx')

    expect(card).toContain('approvalRefusal')
    expect(card).toContain('refusalWords')
  })
})

describe('доступность узкой полосы утверждена прогоном, а не описана в прозе', () => {
  it('файлы узкой полосы вообще нашлись — иначе всё ниже было бы зелёным впустую', () => {
    const files = narrowMarkupFiles().map((f) => f.name)

    expect(files).toContain('NarrowTasks.tsx')
    expect(files).toContain('NarrowTaskCard.tsx')
  })

  it('строка списка — настоящая кнопка, а не «див» с обработчиком, до которого не добраться', () => {
    for (const file of narrowMarkupFiles()) {
      const tags = clickableTagNames(file.src)
      expect(tags.length, `${file.name}: нажимаемого нет вовсе`).toBeGreaterThan(0)
      expect([...new Set(tags)], `${file.name}: обработчик стоит не на кнопке`).toEqual(['button'])
    }
  })

  it('проверка «обработчик на кнопке» умеет краснеть — на поддельном плохом исходнике', () => {
    const bad = '<div onClick={() => open(id)} className="row">строка</div>'

    expect([...new Set(clickableTagNames(bad))]).toEqual(['div'])
  })

  it('у каждой нажимаемой цели заявлен пол попадания пальцем', () => {
    expect(TAP_MIN_PX).toBe(44)

    for (const file of narrowMarkupFiles()) {
      expect(buttonsWithoutTapFloor(file.src, TAP_MIN_PX), `${file.name}: цель ниже пола`).toEqual([])
    }
  })

  it('проверка пола попадания умеет краснеть — на поддельной кнопке без него', () => {
    const bad = '<button type="button" onClick={() => go()} className="px-2 py-1">жать</button>'

    expect(buttonsWithoutTapFloor(bad, TAP_MIN_PX)).toHaveLength(1)
    expect(buttonsWithoutTapFloor('<button className="min-h-[44px]">жать</button>', TAP_MIN_PX)).toEqual([])
  })

  it('текст не опускается ниже читаемого', () => {
    expect(TEXT_MIN_PX).toBe(13)

    for (const file of narrowMarkupFiles()) {
      const smallest = smallestTextPx(file.src)
      expect(smallest, `${file.name}: размеров текста не заявлено вовсе`).not.toBeNull()
      expect(smallest as number, `${file.name}: текст мельче читаемого`).toBeGreaterThanOrEqual(TEXT_MIN_PX)
    }
  })

  it('проверка размера текста умеет краснеть — на поддельной мелкой подписи', () => {
    expect(smallestTextPx('<span className="text-[10.5px] text-tx3">мелко</span>')).toBe(10.5)
    expect(smallestTextPx('<span className="text-tx3">без размера</span>')).toBeNull()
  })

  it('у каждой кнопки видна рамка фокуса — клавиатура должна показывать, где она стоит', () => {
    for (const file of narrowMarkupFiles()) {
      expect(buttonsWithoutFocusRing(file.src), `${file.name}: фокус не виден`).toEqual([])
    }
  })

  it('слой поверх экрана объявляет себя диалогом — и тогда несёт aria-modal', () => {
    for (const file of narrowMarkupFiles()) {
      expect(dialogsWithoutAriaModal(file.src), `${file.name}: слой-диалог без aria-modal`).toEqual([])
    }
  })

  it('проверка aria-modal умеет краснеть — на поддельной шторке без него', () => {
    const bad = '<aside role="dialog" aria-label="Меню" className="fixed inset-0">меню</aside>'
    const good = '<aside role="dialog" aria-modal="true" aria-label="Меню" className="fixed inset-0">меню</aside>'

    expect(dialogsWithoutAriaModal(bad)).toHaveLength(1)
    expect(dialogsWithoutAriaModal(good)).toEqual([])
  })
})
