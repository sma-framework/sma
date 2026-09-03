/**
 * ЖЁСТКОГО ПОЛА ШИРИНЫ НЕТ НИ НА ОДНОМ ЭКРАНЕ ОКНА — ПРОВЕРЕНО ПОДМЕТАНИЕМ, А НЕ ПАМЯТЬЮ.
 *
 * ═══════════════ ПОЧЕМУ ВСЕ ЭКРАНЫ, А НЕ ТОТ, ГДЕ МИНУ УЖЕ НАШЛИ ═══════════════
 * Один раз жёсткая нижняя ширина уже стоила ложного возврата чужой работы: пол в пикселях на
 * экране первого запуска уносил вбок всю страницу, живой прогон честно давал блокеры
 * переполнения, и блокеры прочитали как дефект ветки, а не как дефект сцены. Тот экран
 * починен и держится своим прогоном. Но пол — это КЛАСС мины, а не одно место: та же строка,
 * написанная на любом другом экране, даёт ту же болезнь, и найти её глазами второй раз никто
 * не обязан.
 *
 * Поэтому здесь подметается разметка ОКНА ЦЕЛИКОМ, а список файлов берётся с диска: экран,
 * добавленный завтра, попадает под ту же проверку сам, без строки в списке.
 *
 * ═══════════════ ЧТО СЧИТАЕТСЯ КОМНАТОЙ, И ПОЧЕМУ ЧИСЛО НЕ НАБРАНО РУКАМИ ═══════════════
 * Комната экрана стола — это НЕ ширина монитора: рама широкого окна обещает ровно свой минимум
 * (WIDE_MIN_PX, модуль узкой работы), из него боковая колонка берёт своё фиксированное, а поля
 * самого экрана берут своё. Всё три числа читаются из исходника — константа из модуля, ширина
 * колонки из класса самой колонки, поле из класса того же файла, — потому что второе число об
 * одной и той же вещи расходится с первым молча.
 *
 * Пол больше комнаты — это не «широковато»: на самой узкой ширине, при которой широкая рама
 * вообще показывается, содержимое уезжает вбок, и человек добирается до него перетаскиванием.
 *
 * ═══════════════ ЧТО ЭТОТ ФАЙЛ НЕ УТВЕРЖДАЕТ ═══════════════
 * Он не заменяет живой прогон и не измеряет пикселей: помещается ли строка в отведённое ей
 * место со шрифтом браузера — вопрос к браузеру. Здесь закрыто ровно то, что дешевле всего
 * проглядеть и чего живой прогон НЕ видит: его развёртка переполнения ходит на четыре уровня
 * вглубь страницы, а пол, поставленный на сетке внутри экрана, лежит глубже.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { WIDE_MIN_PX } from '../../spa/src/shell/narrow/narrow'

const SPA_SRC = fileURLToPath(new URL('../../spa/src/', import.meta.url))

/** Самая узкая ширина, которую открывает живой прогон (VIEWPORTS в lib/ui-drive.mjs). */
const NARROW_VIEWPORT_PX = 375

type Markup = { path: string; src: string }

/** Вся разметка окна — с диска, а не списком: следующий экран попадёт сюда сам. */
function markupFiles(dir = SPA_SRC, prefix = ''): Markup[] {
  const out: Markup[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...markupFiles(`${dir}${entry.name}/`, `${prefix}${entry.name}/`))
    else if (entry.name.endsWith('.tsx')) out.push({ path: `${prefix}${entry.name}`, src: readFileSync(dir + entry.name, 'utf8') })
  }
  return out
}

/** Классы поштучно: строка className — это слова через пробел, что бы её ни окружало. */
function classTokens(src: string): string[] {
  return src.split(/[\s"'`{}()]+/).filter(Boolean)
}

/**
 * Полы ширины, объявленные БЕЗУСЛОВНО, — те, что действуют на любой ширине окна.
 *
 * Приставка перелома (`lg:min-w-[…]`) включает пол только там, где место для него уже есть, и
 * потому миной не является. `max-w-` сюда не попадает нарочно: потолок ширины ничего не выносит
 * вбок, он только не даёт разъехаться.
 */
export function unconditionalFloors(src: string): number[] {
  const out: number[] = []
  for (const token of classTokens(src)) {
    const m = /^(?:([a-z0-9]+):)?min-w-\[(\d+)px\]$/.exec(token)
    if (m && m[1] === undefined) out.push(Number(m[2]))
  }
  return out
}

/** Фиксированная ширина, заявленная классом: `w-[248px]`. Потолок и пол — не она. */
export function fixedWidthPx(src: string): number | null {
  for (const token of classTokens(src)) {
    const m = /^w-\[(\d+)px\]$/.exec(token)
    if (m) return Number(m[1])
  }
  return null
}

/** Отступ, заявленный классом: `px-5` — это пятёрка шага в 4px, `px-[34px]` — сам себе число. */
export function padPx(token: string): number | null {
  const step = /^px-(\d+(?:\.\d+)?)$/.exec(token)
  if (step) return Number(step[1]) * 4
  const literal = /^px-\[(\d+)px\]$/.exec(token)
  return literal ? Number(literal[1]) : null
}

/** Самое широкое боковое поле, заявленное в файле: его обязан пережить любой пол в нём. */
function widestPad(src: string): number {
  const pads = classTokens(src)
    .map(padPx)
    .filter((n): n is number => n !== null)
  return pads.length > 0 ? Math.max(...pads) : 0
}

/** Ширина боковой колонки — из класса самой колонки, а не набранная здесь вторым числом. */
function sidebarPx(): number {
  const sidebar = readFileSync(`${SPA_SRC}shell/Sidebar.tsx`, 'utf8')
  const aside = /<aside[^>]*>/.exec(sidebar)?.[0] ?? ''
  return fixedWidthPx(aside) ?? Number.NaN
}

/** Рама широкого стола: она и есть тот минимум, о котором договорились, — её пол не мина, а контракт. */
const FRAME = 'shell/Shell.tsx'

/** Узкая работа живёт под порогом рамы, и комната у неё телефонная, а не столовая. */
function isNarrowWork(path: string): boolean {
  return path.startsWith('shell/narrow/') || path.startsWith('screens/first-run/')
}

describe('комната экрана стола посчитана из исходника, а не набрана рядом', () => {
  it('ширина боковой колонки читается из класса самой колонки', () => {
    expect(sidebarPx()).toBeGreaterThan(0)
    expect(sidebarPx()).toBeLessThan(WIDE_MIN_PX)
  })

  it('чтение ширины умеет краснеть — и не путает потолок и пол с шириной', () => {
    expect(fixedWidthPx('<aside className="sticky w-[248px] flex-none">…</aside>')).toBe(248)
    expect(fixedWidthPx('<aside className="max-w-[248px]">…</aside>')).toBeNull()
    expect(fixedWidthPx('<aside className="min-w-[248px]">…</aside>')).toBeNull()
  })

  it('чтение поля умеет обе записи — шаг и литерал', () => {
    expect(padPx('px-7')).toBe(28)
    expect(padPx('px-[34px]')).toBe(34)
    expect(padPx('pt-6')).toBeNull()
    expect(widestPad('<div className="px-4"><div className="px-7">…</div></div>')).toBe(28)
  })
})

describe('ни один экран окна не ставит пол шире комнаты, которую обещает рама', () => {
  it('подметание действительно нашло разметку — иначе всё ниже зелено впустую', () => {
    const files = markupFiles()

    expect(files.length).toBeGreaterThan(30)
    expect(files.map((f) => f.path)).toContain(FRAME)
    expect(files.map((f) => f.path)).toContain('screens/team/index.tsx')
  })

  it('пол каждого экрана стола помещается в минимум рамы за вычетом колонки и полей', () => {
    const room = WIDE_MIN_PX - sidebarPx()

    for (const file of markupFiles()) {
      if (file.path === FRAME || isNarrowWork(file.path)) continue
      const fits = room - 2 * widestPad(file.src)
      const tooWide = unconditionalFloors(file.src).filter((px) => px > fits)
      expect(tooWide, `${file.path}: пол ширины шире комнаты в ${fits}px`).toEqual([])
    }
  })

  it('пол узкой работы помещается в телефон', () => {
    for (const file of markupFiles()) {
      if (!isNarrowWork(file.path)) continue
      const fits = NARROW_VIEWPORT_PX - 2 * widestPad(file.src)
      const tooWide = unconditionalFloors(file.src).filter((px) => px > fits)
      expect(tooWide, `${file.path}: пол ширины шире телефона (${fits}px)`).toEqual([])
    }
  })

  it('единственное исключение — сама рама, и её пол равен тому самому порогу', () => {
    const frame = markupFiles().find((f) => f.path === FRAME)!

    expect(unconditionalFloors(frame.src)).toEqual([WIDE_MIN_PX])
  })

  it('подметание умеет краснеть — на поддельной разметке с полом и без него', () => {
    expect(unconditionalFloors('<div className="grid min-w-[1160px] grid-cols-4">…</div>')).toEqual([1160])
    expect(unconditionalFloors('<div className="2xl:min-w-[1160px]">…</div>')).toEqual([])
    expect(unconditionalFloors('<div className="min-w-0 max-w-[1520px]">…</div>')).toEqual([])
  })
})

describe('роспись команды считает столбцы по месту, а не держит их число', () => {
  const roster = () => markupFiles().find((f) => f.path === 'screens/team/index.tsx')!.src

  it('в разметке росписи объявлена ширина ОДНОЙ карточки, а не ширина всей сетки', () => {
    const track = /repeat\(auto-fill,\s*minmax\((\d+)px,\s*1fr\)\)/.exec(roster())

    expect(track, 'сетка росписи не считает столбцы по месту').not.toBeNull()
    expect(Number(track![1])).toBeGreaterThan(0)
  })

  it('карточка помещается в комнату рамы даже вчетвером не встав', () => {
    const track = /repeat\(auto-fill,\s*minmax\((\d+)px,\s*1fr\)\)/.exec(roster())!
    const room = WIDE_MIN_PX - sidebarPx() - 2 * widestPad(roster())

    expect(Number(track[1])).toBeLessThanOrEqual(room)
  })

  it('прибитого числа столбцов без условия ширины в росписи не осталось', () => {
    const pinned = classTokens(roster()).filter((t) => /^grid-cols-\d+$/.test(t))

    expect(pinned, 'число столбцов прибито и на узком столе тоже').toEqual([])
  })
})
