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
  RING_BASE_RADIUS,
  RING_COUNT,
  RING_CYCLE_S,
  RING_FADE_IN_S,
  RING_FADE_OUT_S,
  RING_GAP_S,
  RING_LINE_PX,
  RING_NOISE,
  RING_PEAK_PCT,
  RING_RADIUS_STEP,
  RING_SETTLE_PCT,
  RING_SPEED,
  RING_SWELL,
  SETTLE_MS,
  TRANSITION_CAP_MS,
  WAIT_CENTER,
  WAIT_FRAME,
  WAIT_PROJECT,
  WAIT_RINGS,
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
const LANGUAGE_TS = src('../../spa/src/shell/waiting-language.ts')
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
  it('шесть колец, и каждое названо токеном, а не хексом', () => {
    expect(WAIT_RINGS).toHaveLength(RING_COUNT)
    expect(RING_COUNT).toBe(6)
    for (const ring of WAIT_RINGS) expect(ring.stroke).toMatch(/^--color-wait-[1-6]$/)
    expect(new Set(WAIT_RINGS.map((r) => r.stroke)).size).toBe(RING_COUNT)
    expect(WAIT_SKY).toBe('--color-wait-sky')
  })

  it('ни одно кольцо не взято из палитры ошибки: красный в этом окне означает поломку', () => {
    for (const ring of WAIT_RINGS) expect(ring.stroke).not.toContain('err')
    expect(WAITING_TSX).not.toMatch(/err/)
  })

  it('розово-голубая пара образца не доехала ни до одного файла окна', () => {
    // Числа у образца взяли, палитру — нет. Цвета названы здесь дословно, чтобы копия образца,
    // вставленная «как есть» в любой из этих файлов, краснела прогоном, а не отзывом владельца.
    for (const hex of ['#fc42ff', '#42fcff']) {
      expect(`${WAITING_TSX}${TOKENS}${SHELL}${APP}`.toLowerCase()).not.toContain(hex.toLowerCase())
    }
  })

  it('каждый цвет ожидания объявлен ДВАЖДЫ — в светлой теме и в тёмной', () => {
    for (const name of [WAIT_SKY, ...WAIT_RINGS.map((r) => r.stroke)]) {
      const declared = TOKENS.match(new RegExp(`${name}:\\s*#[0-9a-fA-F]{3,8};`, 'g')) ?? []
      expect(declared.length, `${name} объявлен ${declared.length} раз(а)`).toBe(2)
    }
  })

  it('компонент берёт цвет переменной темы, а не собственным хексом', () => {
    expect(WAITING_TSX).not.toMatch(/#[0-9a-fA-F]{6}/)
    expect(WAITING_TSX).toContain('var(')
  })

  it('имя каждого цвета выписано в исходнике ЦЕЛИКОМ — иначе сборка выбросит его молча', () => {
    // Красный случай измерен, а не придуман: пока имена собирались из кусков
    // (`--color-wait-${i + 1}`), сборщик тем не нашёл их в исходниках, счёл неиспользованными и
    // выбросил из светлой темы ВСЕ ШЕСТЬ. Кольца пропали с экрана, тёмная тема уцелела (её
    // значения объявлены обычным правилом), а сборка и типы остались зелёными. Прогон держит
    // ровно то условие, которое нужно сборщику: имя есть в тексте исходника целиком.
    for (const name of [WAIT_SKY, ...WAIT_RINGS.map((r) => r.stroke)]) {
      expect(LANGUAGE_TS, `${name} собран из кусков — сборка выбросит его из светлой темы`).toContain(
        `'${name}'`,
      )
    }
  })
})

describe('вид ожидания: кольца концентрические, движение спокойное', () => {
  it('радиусы растут ровным шагом от общего центра — это кольца, а не пятна', () => {
    const radii = WAIT_RINGS.map((r) => r.radius)
    expect([...radii].sort((a, b) => a - b)).toEqual(radii)
    expect(radii[0]).toBe(Math.round(RING_BASE_RADIUS * WAIT_FRAME))
    for (let i = 1; i < radii.length; i += 1) {
      expect(radii[i] - radii[i - 1]).toBe(Math.round(RING_RADIUS_STEP * WAIT_FRAME))
    }
    // Кадр квадратный и центр у него один: круг в растянутом кадре кольцом уже не является.
    expect(WAIT_CENTER).toBe(WAIT_FRAME / 2)
    expect(WAITING_TSX).toContain('preserveAspectRatio="xMidYMid meet"')
  })

  it('кольца вспыхивают по очереди — волна идёт от центра наружу', () => {
    const delays = WAIT_RINGS.map((r) => r.delay)
    expect(new Set(delays).size).toBe(delays.length)
    // Внутреннее кольцо начинает раньше внешнего, соседи разведены на паузу образца.
    for (let i = 1; i < delays.length; i += 1) expect(delays[i] - delays[i - 1]).toBeCloseTo(RING_GAP_S)
    // Задержка отрицательна у всех: положительная оставила бы поле недорисованным в первые
    // секунды ожидания — ровно тогда, когда на него смотрят внимательнее всего.
    for (const d of delays) expect(d).toBeLessThan(0)
    expect(RING_CYCLE_S).toBe((RING_COUNT * RING_GAP_S) / RING_SPEED)
  })

  it('движение спокойное: линия тонкая, набухание малое, шум лёгкий', () => {
    expect(RING_LINE_PX).toBeLessThanOrEqual(3)
    expect(RING_SWELL).toBeGreaterThan(1)
    expect(RING_SWELL).toBeLessThanOrEqual(1.1)
    expect(RING_NOISE).toBeGreaterThan(0)
    expect(RING_NOISE).toBeLessThanOrEqual(0.15)
    // Линия названа в ЭКРАННЫХ пикселях, иначе узкая карточка рисовала бы волосок.
    expect(WAITING_TSX).toContain('vectorEffect="non-scaling-stroke"')
    expect(WAITING_TSX).toContain('feTurbulence')
  })

  it('у ожидания нет рук: ни слежения за мышью, ни вспышки по клику', () => {
    // Требование владельца и не украшение: фон, отвечающий на руку, обещает, что здесь есть
    // чем управлять, — а управлять нечем, здесь ждут ответа двери.
    expect(WAITING_TSX).not.toMatch(/onMouse|onPointer|onClick|addEventListener|requestAnimationFrame/)
  })

  it('покойная яркость убывает наружу и объявлена вне анимации — есть что оставить без движения', () => {
    const rests = WAIT_RINGS.map((r) => r.rest)
    expect([...rests].sort((a, b) => b - a)).toEqual(rests)
    for (const rest of rests) {
      expect(rest).toBeGreaterThan(0)
      expect(rest).toBeLessThan(1)
    }
    expect(TOKENS).toMatch(/\.sma-wait-ring\s*\{[^}]*opacity:\s*var\(--sma-ring-rest/)
  })

  it('числа кадров в CSS — те же самые, что объявлены модулем', () => {
    // Считать проценты в CSS нечем, поэтому они переписаны туда числами; два написания одного
    // темпа расходятся молча — правят одно, второе остаётся.
    expect(RING_PEAK_PCT).toBeCloseTo((100 * RING_FADE_IN_S) / RING_CYCLE_S, 1)
    expect(RING_SETTLE_PCT).toBeCloseTo((100 * (RING_FADE_IN_S + RING_FADE_OUT_S)) / RING_CYCLE_S, 1)
    expect(TOKENS).toContain(`${RING_PEAK_PCT}%`)
    expect(TOKENS).toContain(`${RING_SETTLE_PCT}%`)
    expect(TOKENS).toContain(`animation-duration: ${RING_CYCLE_S}s`)
    expect(TOKENS).toContain(`scale(${RING_SWELL})`)
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
    expect(TOKENS).toContain(`${SETTLE_MS}ms`)
  })

  it('«уменьшить движение» — и кольца замирают', () => {
    expect(TOKENS).toContain(REDUCED_MOTION)
    const rule = TOKENS.slice(TOKENS.indexOf(REDUCED_MOTION))
    expect(rule).toContain('.sma-wait-ring')
    expect(rule).toMatch(/\.sma-wait-ring\s*\{[^}]*animation:\s*none/)
  })

  it('движение фона объявлено только у колец — замирать больше нечему', () => {
    expect(TOKENS).toMatch(/@keyframes sma-wait-ring/)
    expect(TOKENS).not.toContain('sma-wait-layer')
    expect(WAITING_TSX).toContain('sma-wait-ring')
  })
})

describe('ожидание доехало до окна', () => {
  it('рама показывает ожидание ВМЕСТО экрана, а не рядом с ним', () => {
    expect(SHELL).toContain('screenWaits')
    expect(SHELL).toMatch(/waits\s*\?\s*\(?\s*<Waiting/)
    // …и обратная половина: приехавшее содержимое проступает, а не вспыхивает на месте полосы.
    expect(SHELL).toContain('sma-wait-settle')
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

  it('карточка стоит там, где приедет содержимое, и не занимает окно целиком', () => {
    // Правка масштаба к образцу: заставка во весь экран уводит глаз с места, где появится ответ.
    expect(WAITING_TSX).not.toContain('min-h-screen')
    expect(WAITING_TSX).not.toContain('fixed inset-0')
  })

  it('слова стоят ПОВЕРХ колец, а не вместо них: фон не заменяет языка ожидания', () => {
    // Кольца — фон и лежат отдельным слоем во всю карточку; строка состояния стоит над ними и
    // читается по затемнению. Порядок в разметке и есть порядок слоёв.
    const rings = WAITING_TSX.indexOf('<svg')
    const words = WAITING_TSX.indexOf('aria-live')
    expect(rings).toBeGreaterThan(-1)
    expect(words).toBeGreaterThan(rings)
    expect(WAITING_TSX).toMatch(/<svg[^>]*absolute inset-0/)
    expect(WAITING_TSX).toContain('{words.text}')
  })

  it('область ожидания объявлена занятой, а кольца от помощника скрыты', () => {
    expect(WAITING_TSX).toContain('aria-busy')
    expect(WAITING_TSX).toContain('aria-hidden')
    expect(WAITING_TSX).toContain('aria-live')
  })
})
