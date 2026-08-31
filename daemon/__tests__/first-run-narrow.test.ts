/**
 * ЭКРАН ПЕРВОГО ЗАПУСКА ПОМЕЩАЕТСЯ В ТЕЛЕФОН, А НЕ ТОЛКАЕТ СТРАНИЦУ ВБОК.
 *
 * ═══════════════ ПОЧЕМУ ИМЕННО ЭТОТ ЭКРАН, А НЕ ЛЮБОЙ ДРУГОЙ ═══════════════
 * Первый запуск — единственный экран, который человек видит ДО того, как у него появилось
 * окно: он занимает страницу целиком, минуя раму (см. App.tsx), а значит и минуя развилку
 * «широкое окно или узкая полоса». Всё, что рама решает за остальные экраны, здесь не решает
 * никто. Жёсткая нижняя ширина, поставленная на такой экран, уносит вбок ВСЮ страницу — на
 * планшете и на телефоне человек видит логотип и два полуслова, а прокрутка вправо тащит
 * интерфейс, а не показывает следующую колонку.
 *
 * Цена этого уже заплачена и не гипотетическая: живой прогон честно давал два блокера
 * «overflow» на 768 и 375 — и, поскольку прогон меряет ИМЕННО экран посадки, эти блокеры
 * приезжали на каждую работу, отведённую от сцены без подключённого проекта. Один раз их
 * прочитали как дефект чужой работы и вернули её с точным, но неверным адресом.
 *
 * ═══════════════ ПОЧЕМУ ЧИСЛО СЧИТАЕТСЯ, А НЕ НАБИРАЕТСЯ РУКАМИ ═══════════════
 * «Помещается в телефон» — это 375 минус поля самого экрана, и поле здесь тоже не константа
 * из головы: оно читается ИЗ КЛАССА того самого контейнера. Написать 335 рядом руками значит
 * завести второе число об одних и тех же полях; на первой же правке отступов они разойдутся,
 * и разойдутся молча.
 *
 * ЧТО ЭТОТ ФАЙЛ НЕ УТВЕРЖДАЕТ. Он не заменяет живой прогон: помещается ли строка кнопок в
 * 335 пикселей — вопрос к браузеру со шрифтом, а не к строке класса, и отвечает на него
 * ui-drive на трёх ширинах. Здесь закрыто то, что дешевле всего проглядеть и что живой прогон
 * покажет уже постфактум: жёсткий пол ширины, коробка шире телефона и точка перестроения,
 * разъехавшаяся между двумя файлами.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

const DIR = fileURLToPath(new URL('../../spa/src/screens/first-run/', import.meta.url))

/** Разметка экрана — все три файла, а не только тот, где нашли мину в прошлый раз. */
const MARKUP = ['index.tsx', 'StepPanel.tsx', 'ReadyColumn.tsx'].map((name) => ({
  name,
  src: readFileSync(DIR + name, 'utf8'),
}))

const INDEX = MARKUP.find((f) => f.name === 'index.tsx')!.src
const READY = MARKUP.find((f) => f.name === 'ReadyColumn.tsx')!.src

/** Самая узкая ширина, которую открывает живой прогон (VIEWPORTS в lib/ui-drive.mjs). */
const NARROW_VIEWPORT_PX = 375

/** Классы поштучно: строка className — это слова через пробел, что бы её ни окружало. */
function classTokens(src: string): string[] {
  return src.split(/[\s"'`{}()]+/).filter(Boolean)
}

/** Отступ, заявленный классом: `px-5` — это пятёрка шага в 4px, `px-[34px]` — сам себе число. */
export function padPx(token: string): number | null {
  const step = /^px-(\d+(?:\.\d+)?)$/.exec(token)
  if (step) return Number(step[1]) * 4
  const literal = /^px-\[(\d+)px\]$/.exec(token)
  return literal ? Number(literal[1]) : null
}

/**
 * Открывающий тег, начатый в этом месте, целиком — вместе со всеми его классами.
 *
 * Границей тега считается `>` ВНЕ фигурных скобок: стрелка обработчика (`() => …`) живёт
 * внутри них, и наивный поиск первого `>` резал бы тег ровно по ней.
 */
function tagAt(src: string, open: number): string | null {
  let depth = 0
  for (let j = open; j < src.length; j += 1) {
    const c = src[j]
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    else if (c === '>' && depth === 0) return src.slice(open, j + 1)
  }
  return null
}

/** Открывающий тег, несущий данный класс, целиком — вместе со всеми остальными его классами. */
function tagCarrying(src: string, needle: string): string | null {
  const at = src.indexOf(needle)
  return at === -1 ? null : tagAt(src, src.lastIndexOf('<', at))
}

/**
 * Ширины, объявленные разметкой: сама ширина, её условие и число.
 *
 * Условие — это приставка перелома (`lg:w-[356px]`): ширина под условием включается только
 * там, где место для неё уже есть, и телефону она не мешает. Приставки нет — ширина стоит
 * всегда, и отвечать за телефон обязана она сама. `max-w-` сюда не попадает нарочно: потолок
 * ширины ничего не выносит вбок, он только не даёт разъехаться.
 */
export function widthDeclarations(src: string, base: 'w' | 'min-w'): { prefix: string | null; px: number }[] {
  const re = new RegExp(`^(?:([a-z0-9]+):)?${base}-\\[(\\d+)px\\]$`)
  const out: { prefix: string | null; px: number }[] = []
  for (const token of classTokens(src)) {
    const m = re.exec(token)
    if (m) out.push({ prefix: m[1] ?? null, px: Number(m[2]) })
  }
  return out
}

/** Ширины без условия — те, что действуют и на телефоне тоже. */
function unconditional(src: string, base: 'w' | 'min-w'): number[] {
  return widthDeclarations(src, base)
    .filter((d) => d.prefix === null)
    .map((d) => d.px)
}

/**
 * Тег-родитель того, кто написан внутри него: разметка читается стопкой открытых `div`.
 *
 * Ищется не «див перед словом», а именно охватывающий: между рядом и колонкой стоит ещё одна
 * коробка, и наивный поиск назад нашёл бы её, а не ряд.
 */
export function parentTagOf(src: string, child: string): string | null {
  const target = src.indexOf(child)
  if (target === -1) return null
  const stack: string[] = []
  const re = /<div\b|<\/div>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m.index > target) break
    if (m[0] === '</div>') stack.pop()
    else stack.push(tagAt(src, m.index) ?? m[0])
  }
  return stack.length > 0 ? stack[stack.length - 1] : null
}

/** Приставка перелома у класса — то условие ширины, под которым он включается. */
export function breakAt(src: string, cls: string): string | null {
  for (const token of classTokens(src)) {
    const m = new RegExp(`^([a-z0-9]+):${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).exec(token)
    if (m) return m[1]
  }
  return null
}

describe('экран первого запуска: жёсткого пола ширины нет ни в одном файле', () => {
  it('ни один файл разметки не объявляет min-w в пикселях без условия ширины', () => {
    for (const file of MARKUP) {
      expect(unconditional(file.src, 'min-w'), `${file.name}: жёсткий пол ширины`).toEqual([])
    }
  })

  it('проверка пола умеет краснеть — на поддельной разметке с ним', () => {
    expect(unconditional('<div className="mx-auto min-w-[1280px] px-14">…</div>', 'min-w')).toEqual([1280])
    // …и не краснеет там, где пол включается только с появившейся для него шириной
    expect(unconditional('<div className="lg:min-w-[1280px]">…</div>', 'min-w')).toEqual([])
  })
})

describe('экран первого запуска: ничто не шире телефона, пока ширины не хватило', () => {
  it('поле экрана читается из класса самого контейнера, а не набирается рядом', () => {
    const container = tagCarrying(INDEX, 'max-w-[1520px]')
    expect(container).not.toBeNull()
    const pads = classTokens(container as string)
      .map(padPx)
      .filter((n): n is number => n !== null)
    expect(pads.length, 'у контейнера экрана не заявлено поля вовсе').toBeGreaterThan(0)
    expect(Math.min(...pads)).toBeGreaterThan(0)
  })

  it('проверка поля умеет читать обе записи — шаг и литерал', () => {
    expect(padPx('px-5')).toBe(20)
    expect(padPx('px-14')).toBe(56)
    expect(padPx('px-[34px]')).toBe(34)
    expect(padPx('pt-6')).toBeNull()
    expect(padPx('max-w-[1520px]')).toBeNull()
  })

  it('каждая безусловная фиксированная ширина помещается в телефон за вычетом полей', () => {
    const container = tagCarrying(INDEX, 'max-w-[1520px]') as string
    const pad = Math.min(
      ...classTokens(container)
        .map(padPx)
        .filter((n): n is number => n !== null),
    )
    const room = NARROW_VIEWPORT_PX - 2 * pad

    for (const file of MARKUP) {
      const tooWide = unconditional(file.src, 'w').filter((px) => px > room)
      expect(tooWide, `${file.name}: коробка шире ${room}px стоит без условия ширины`).toEqual([])
    }
  })

  it('проверка ширины умеет краснеть — и не путает потолок с полом', () => {
    expect(unconditional('<div className="w-[356px] flex-none">…</div>', 'w')).toEqual([356])
    expect(unconditional('<div className="w-full lg:w-[356px]">…</div>', 'w')).toEqual([])
    // потолок ширины вбок не выносит: он ограничивает, а не требует
    expect(unconditional('<div className="max-w-[1520px]">…</div>', 'w')).toEqual([])
    // и пол — не ширина: у него своя проверка выше
    expect(unconditional('<div className="min-w-[280px]">…</div>', 'w')).toEqual([])
  })
})

describe('экран первого запуска: на узкой ширине он перестраивается, а не едет вбок', () => {
  it('ряд «разговор и колонка» стоит столбцом, пока не появилась ширина на два столбца', () => {
    const row = parentTagOf(INDEX, '<ReadyColumn')
    expect(row, 'родителя колонки в разметке не нашлось').not.toBeNull()
    expect(row as string).toContain('flex-col')
    expect(breakAt(row as string, 'flex-row'), 'ряд разворачивается без условия ширины').not.toBeNull()
  })

  it('проверка родителя умеет краснеть — на поддельной разметке', () => {
    const bad = '<div className="flex gap-4"><div className="flex-1">x</div><ReadyColumn /></div>'
    expect(parentTagOf(bad, '<ReadyColumn')).toContain('flex gap-4')
    expect(breakAt(parentTagOf(bad, '<ReadyColumn') as string, 'flex-row')).toBeNull()
  })

  it('колонка «что уже готово» занимает всю ширину, пока своей ей не хватает', () => {
    expect(READY).toContain('w-full')
    expect(breakAt(READY, 'w-[356px]'), 'колонка держит свою ширину и на телефоне').not.toBeNull()
  })

  it('точка перестроения ОДНА: ряд и колонка ломаются на одной и той же ширине', () => {
    const row = parentTagOf(INDEX, '<ReadyColumn') as string
    expect(breakAt(READY, 'w-[356px]')).toBe(breakAt(row, 'flex-row'))
  })

  it('полоса шагов не держит четыре столбца на телефоне', () => {
    const bar = tagCarrying(INDEX, 'grid-cols-4')
    expect(bar, 'полосы шагов в разметке не нашлось').not.toBeNull()
    expect(breakAt(INDEX, 'grid-cols-4'), 'четыре столбца стоят без условия ширины').not.toBeNull()
  })
})
