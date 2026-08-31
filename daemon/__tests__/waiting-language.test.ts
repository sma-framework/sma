/**
 * ЕДИНЫЙ ЯЗЫК ОЖИДАНИЯ — ПРОГОНОМ, А НЕ ГЛАЗОМ.
 *
 * Жалоба была про белое место: человек переключает проект, слева переключатель честно говорит,
 * куда идёт, а справа — пусто, и понять, случилось ли что-нибудь, нельзя. Починка тут особая:
 * ВСЁ, что она делает, происходит ровно в те секунды, когда смотреть не на что, — и потому
 * проверяется хуже всего глазами. Полоса, всплывшая поверх живого экрана на каждом опросе,
 * выглядит правдоподобно. Полоса, не всплывшая вовсе, выглядит правдоподобно. Слова, которые
 * так и не появились, потому что порог сравнили не с тем, выглядят правдоподобно тоже.
 *
 * Поэтому здесь три разных вопроса, и каждый — к своему хозяину:
 *
 *  1. РЕШЕНИЕ «ждать или показывать» — чистая функция над четырьмя входами (`screenWaits`).
 *     Её красный случай — обычный опрос раз в три секунды: картина про тот же проект, чтение
 *     идёт, показывать есть что, и ожидание тут — дефект, а не забота.
 *  2. СЛОВА — что идёт и сколько уже. Движение обещает, слова говорят правду: без порога
 *     красивая анимация превращает зависшее окно в задуманное.
 *  3. ВИД — цвет, глубина, границы перехода и признак «уменьшить движение». Это решения,
 *     записанные в токенах и в одном компоненте; прогон держит их на месте, потому что
 *     разъезжаются они молча — по одному экрану за раз.
 *
 * DOM здесь не нужен ни разу: решение — функция, слова — функция, а вид — текст исходников,
 * который проверяется чтением. Ровно та же граница, что у таймера и у окошка показателей.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { durationWords } from '../../spa/src/shell/live-timer'
import {
  APPEAR_MS,
  REDUCED_MOTION,
  SETTLE_MS,
  TRANSITION_CAP_MS,
  WAIT_LAYERS,
  WAIT_PROJECT,
  WAIT_SKY,
  WAIT_WINDOW,
  WORDS_AFTER_MS,
  WORDS_MS,
  screenWaits,
  waitingLabel,
  waitingWords,
} from '../../spa/src/shell/waiting-language'

const src = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const TOKENS = src('../../spa/src/theme/tokens.css')
const WAITING_TSX = src('../../spa/src/shell/Waiting.tsx')
const SHELL = src('../../spa/src/shell/Shell.tsx')
const APP = src('../../spa/src/App.tsx')

/** Экраны, чья пустая область содержимого переведена на общий язык ожидания. */
const ADOPTERS = [
  '../../spa/src/screens/backlog/index.tsx',
  '../../spa/src/screens/coordination/index.tsx',
  '../../spa/src/screens/search/index.tsx',
  '../../spa/src/screens/tasks/BatchView.tsx',
  '../../spa/src/screens/tasks/PhaseCardView.tsx',
] as const

/** Обычная картина, приехавшая и совпавшая с тем, что спрашивают. */
const SETTLED = {
  switching: false,
  hasPicture: true,
  answeredFor: 'sma',
  askedFor: 'sma',
  fetching: false,
} as const

describe('ждать или показывать экран', () => {
  it('идёт смена проекта — на месте содержимого ожидание', () => {
    expect(screenWaits({ ...SETTLED, switching: true })).toBe(true)
  })

  it('картина не приезжала ни разу — это первое открытие окна, показывать нечего', () => {
    expect(screenWaits({ ...SETTLED, hasPicture: false, answeredFor: null, askedFor: null })).toBe(true)
  })

  it('картина есть, но про ПРОШЛЫЙ проект, и новая в пути — это и было белое место', () => {
    expect(screenWaits({ ...SETTLED, answeredFor: 'sma', askedFor: 'sma-dev', fetching: true })).toBe(true)
  })

  it('обычный опрос раз в три секунды ожиданием НЕ является', () => {
    // Красный случай этой починки: `fetching` истинно каждые три секунды на любом живом экране.
    // Хватало бы его одного — полоса всплывала бы поверх работающего окна вечно.
    expect(screenWaits({ ...SETTLED, fetching: true })).toBe(false)
  })

  it('картина приехала про тот проект, который спрашивали, — ожидание кончилось', () => {
    expect(screenWaits(SETTLED)).toBe(false)
  })

  it('проект не выбран вовсе — ждать не за чем', () => {
    expect(screenWaits({ ...SETTLED, answeredFor: null, askedFor: null, fetching: true })).toBe(false)
  })
})

describe('слова: что идёт и сколько уже', () => {
  it('до порога слова не показаны — движение обещает раньше, чем нужно объясняться', () => {
    expect(waitingWords(WAIT_WINDOW, 0).shown).toBe(false)
    expect(waitingWords(WAIT_WINDOW, WORDS_AFTER_MS - 1).shown).toBe(false)
  })

  it('порог пройден — слова появляются и называют, сколько уже идёт', () => {
    const words = waitingWords('Открываю проект «sma»', 3000)
    expect(words.shown).toBe(true)
    expect(words.text).toBe('Открываю проект «sma»… идёт 3 с')
  })

  it('порог — пара секунд, а не полминуты: зависание нельзя прятать долго', () => {
    expect(WORDS_AFTER_MS).toBeGreaterThan(0)
    expect(WORDS_AFTER_MS).toBeLessThanOrEqual(3000)
  })

  it('время пишется тем же словарём, что и живой таймер, а не вторым похожим', () => {
    expect(waitingWords('X', 64000).text).toBe(`X… идёт ${durationWords(64)}`)
  })

  it('время назад и время-нечисло не рисуют выдуманного числа', () => {
    expect(waitingWords('X', -5).text).toBe('X… идёт 0 с')
    expect(waitingWords('X', Number.NaN).shown).toBe(false)
  })
})

describe('чего именно ждём — одной строкой', () => {
  it('переключения нет — открывается само окно', () => {
    expect(waitingLabel(null, false)).toBe(WAIT_WINDOW)
    expect(waitingLabel('sma', false)).toBe(WAIT_WINDOW)
  })

  it('переключение названо — назван и проект', () => {
    expect(waitingLabel('sma-dev', true)).toBe(`${WAIT_PROJECT} «sma-dev»`)
  })

  it('имя ещё не приехало — говорим про проект без имени, а не выдумываем его', () => {
    expect(waitingLabel(null, true)).toBe(WAIT_PROJECT)
    expect(waitingLabel('   ', true)).toBe(WAIT_PROJECT)
  })
})

describe('вид ожидания: цвет — из токенов, и ни один не красный', () => {
  it('пять слоёв, и каждый назван токеном, а не хексом', () => {
    expect(WAIT_LAYERS).toHaveLength(5)
    for (const layer of WAIT_LAYERS) {
      expect(layer.fill).toMatch(/^--color-wait-\d$/)
      expect(layer.d).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    }
    expect(WAIT_SKY).toBe('--color-wait-sky')
  })

  it('ни один слой не взят из палитры ошибки: красный в этом окне означает поломку', () => {
    for (const layer of WAIT_LAYERS) expect(layer.fill).not.toContain('err')
    expect(WAITING_TSX).not.toMatch(/err/)
  })

  it('красно-оранжевые числа образца не доехали ни до одного файла окна', () => {
    // Формы у образца взяли, палитру — нет. Числа названы здесь дословно, чтобы копия образца,
    // вставленная «как есть» в любой из этих файлов, краснела прогоном, а не отзывом владельца.
    for (const hex of ['#931C1C', '#f5730a', '#da5b09', '#be4407', '#a32d04', '#871400']) {
      expect(`${WAITING_TSX}${TOKENS}${SHELL}${APP}`.toLowerCase()).not.toContain(hex.toLowerCase())
    }
  })

  it('каждый цвет ожидания объявлен ДВАЖДЫ — в светлой теме и в тёмной', () => {
    for (const name of [WAIT_SKY, ...WAIT_LAYERS.map((l) => l.fill)]) {
      const declared = TOKENS.match(new RegExp(`${name}:\\s*#[0-9a-fA-F]{3,8};`, 'g')) ?? []
      expect(declared.length, `${name} объявлен ${declared.length} раз(а)`).toBe(2)
    }
  })

  it('компонент берёт цвет переменной темы, а не собственным хексом', () => {
    expect(WAITING_TSX).not.toMatch(/#[0-9a-fA-F]{6}/)
    expect(WAITING_TSX).toContain('var(')
  })
})

describe('вид ожидания: глубина, границы перехода и покой', () => {
  it('у каждого слоя своя скорость — иначе это одна картинка, а не горизонт', () => {
    const speeds = WAIT_LAYERS.map((l) => l.seconds)
    expect(new Set(speeds).size).toBe(speeds.length)
    // Дальний слой медленнее ближнего: так и получается глубина, а не рябь.
    expect([...speeds].sort((a, b) => b - a)).toEqual(speeds)
  })

  it('слои едут в разные стороны — чередование знака и есть параллакс', () => {
    const signs = WAIT_LAYERS.map((l) => (l.drift.trim().startsWith('-') ? -1 : 1))
    for (let i = 1; i < signs.length; i += 1) expect(signs[i]).not.toBe(signs[i - 1])
  })

  it('ни один ПЕРЕХОД не длиннее трети секунды', () => {
    for (const ms of [APPEAR_MS, WORDS_MS, SETTLE_MS]) {
      expect(ms).toBeGreaterThan(0)
      expect(ms).toBeLessThanOrEqual(TRANSITION_CAP_MS)
    }
    expect(TRANSITION_CAP_MS).toBe(300)
  })

  it('числа переходов в CSS — те же самые, что объявлены модулем', () => {
    // Два написания одной длительности расходятся молча: правят одно, второе остаётся.
    expect(TOKENS).toContain(`${APPEAR_MS}ms`)
    expect(TOKENS).toContain(`${WORDS_MS}ms`)
  })

  it('«уменьшить движение» — и слои замирают', () => {
    expect(TOKENS).toContain(REDUCED_MOTION)
    const rule = TOKENS.slice(TOKENS.indexOf(REDUCED_MOTION))
    expect(rule).toContain('.sma-wait-layer')
    expect(rule).toMatch(/\.sma-wait-layer\s*\{[^}]*animation:\s*none/)
  })

  it('движение фона объявлено только у слоёв — замирать больше нечему', () => {
    expect(TOKENS).toMatch(/@keyframes sma-wait-drift/)
    expect(WAITING_TSX).toContain('sma-wait-layer')
  })
})

describe('ожидание доехало до окна', () => {
  it('рама показывает ожидание ВМЕСТО экрана, а не рядом с ним', () => {
    expect(SHELL).toContain('screenWaits')
    expect(SHELL).toMatch(/waits\s*\?\s*\(?\s*<Waiting/)
  })

  it('первое открытие окна больше не рисует пустоту', () => {
    // Здесь стояло `return null`: пока дверь не сказала, настроен ли дом, окно рисовало НИЧЕГО.
    expect(APP).not.toMatch(/onboarding\.isLoading\)\s*return null/)
    expect(APP).toContain('<Waiting')
  })

  it('экраны, у которых область белела, говорят общим языком, а не своей строкой', () => {
    for (const path of ADOPTERS) {
      const text = src(path)
      expect(text, path).toContain("from '../../shell/Waiting'")
      expect(text, path).toContain('<Waiting what=')
    }
  })

  it('полоса стоит там, где приедет содержимое, и не занимает окно целиком', () => {
    // Правка масштаба к образцу: заставка во весь экран уводит глаз с места, где появится ответ.
    expect(WAITING_TSX).not.toContain('min-h-screen')
    expect(WAITING_TSX).not.toContain('fixed inset-0')
  })

  it('область ожидания объявлена занятой, а гребни от помощника скрыты', () => {
    expect(WAITING_TSX).toContain('aria-busy')
    expect(WAITING_TSX).toContain('aria-hidden')
    expect(WAITING_TSX).toContain('aria-live')
  })
})
