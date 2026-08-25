/**
 * ЖИВОЙ ТАЙМЕР В ШАПКЕ — ПРОВЕРЯЕТСЯ ПО ФУНКЦИИ, А НЕ ПО ЖИВОМУ ЭКРАНУ.
 *
 * Чип-таймер — единственное на трёх страницах, что меняется САМО, без нового ответа двери, и
 * ровно поэтому его нельзя принять глазом: на живом экране любое число правдоподобно. «Идёт
 * 2 ч» на вставшей задаче и «ждёт вас 4 ч» на той, которую уже одобрили, выглядят так же
 * убедительно, как правда, и расходятся с ней молча.
 *
 * Поэтому решение «какой чип показать» вынесено в `spa/src/shell/live-timer.ts` чистой
 * функцией, часы ей подаёт вызывающий, и здесь утверждается ОНА — с известным «сейчас».
 *
 * ЧТО ИМЕННО УТВЕРЖДАЕТСЯ:
 *
 *   (1) работа идёт → синий чип с КРУТЯЩИМСЯ колечком и растущим временем;
 *   (2) ждёт человека → янтарный чип со СТОЯЩИМ колечком, время ожидания продолжает расти;
 *   (3) встала → красный чип, колечко стоит;
 *   (4) момента НЕТ (поля нет, `null`, пустая строка, мусор, не-число) → чипа нет вовсе:
 *       ни «идёт 0 с», ни «NaN с». Оба написания в этом дереве уже случались;
 *   (5) закрытой сущности (`idle`) чип не рисуется даже при известном моменте — растущее
 *       число на закрытой работе утверждает, что она всё ещё идёт;
 *   (6) момент из БУДУЩЕГО (часы машины ушли вперёд) даёт ноль секунд, а не пропавший чип.
 *
 * Времена на входе все разные: совпадение перепутанных полей исключено.
 */

import { describe, it, expect } from 'vitest'

import { durationWords, momentMs, timerChip } from '../../spa/src/shell/live-timer'

/** Известное «сейчас» — часы подаёт прогон, функция их не читает. */
const NOW = Date.UTC(2026, 7, 25, 12, 0, 0)

describe('timerChip — момент и состояние решают вид чипа', () => {
  it('работа идёт: синий чип, колечко крутится, секунды растут', () => {
    const chip = timerChip('running', NOW - 154_000, NOW)
    expect(chip).not.toBeNull()
    expect(chip!.state).toBe('running')
    expect(chip!.spinning).toBe(true)
    expect(chip!.seconds).toBe(154)
    expect(chip!.word).toBe('идёт')
    expect(chip!.text).toBe('идёт 2 м 34 с')
    expect(chip!.tone).toContain('blue')

    // Через минуту — то же состояние, БОЛЬШЕЕ время: чип и есть доказательство, что система жива.
    expect(timerChip('running', NOW - 154_000, NOW + 60_000)!.seconds).toBe(214)
  })

  it('ждёт человека: янтарный чип, колечко стоит, время ожидания продолжает расти', () => {
    const chip = timerChip('waiting', NOW - 3_723_000, NOW)
    expect(chip!.state).toBe('waiting')
    expect(chip!.spinning).toBe(false)
    expect(chip!.seconds).toBe(3723)
    expect(chip!.text).toBe('ждёт вас 1 ч 2 м 3 с')
    expect(chip!.tone).toContain('warn')
  })

  it('встала: красный чип, колечко стоит', () => {
    const chip = timerChip('failed', NOW - 45_000, NOW)
    expect(chip!.state).toBe('failed')
    expect(chip!.spinning).toBe(false)
    expect(chip!.word).toBe('встала')
    expect(chip!.text).toBe('встала 45 с')
    expect(chip!.tone).toContain('err')
  })

  it('момент приезжает и ISO-строкой попытки, не только числом', () => {
    const chip = timerChip('running', new Date(NOW - 7_000).toISOString(), NOW)
    expect(chip!.seconds).toBe(7)
    expect(chip!.text).toBe('идёт 7 с')
  })

  it('момента нет — чипа нет: ни бодрого нуля, ни NaN', () => {
    for (const missing of [null, undefined, '', '   ', 'не дата', Number.NaN, Infinity]) {
      const chip = timerChip('running', missing as never, NOW)
      expect(chip, `момент ${String(missing)} обязан молчать`).toBeNull()
    }
    // И ни одно из написаний не пролезает через саму разборку момента.
    for (const missing of [null, undefined, '', 'не дата', Number.NaN]) {
      expect(momentMs(missing as never)).toBeNull()
    }
    // Часы, которых нет, — тоже повод молчать, а не рисовать NaN.
    expect(timerChip('running', NOW - 1000, Number.NaN)).toBeNull()
  })

  it('закрытой сущности чип не рисуется даже при известном моменте', () => {
    expect(timerChip('idle', NOW - 999_000, NOW)).toBeNull()
  })

  it('момент из будущего даёт ноль секунд, а не пропавший чип', () => {
    const chip = timerChip('running', NOW + 5_000, NOW)
    expect(chip).not.toBeNull()
    expect(chip!.seconds).toBe(0)
    expect(chip!.text).toBe('идёт 0 с')
  })
})

describe('durationWords — секунды стоят всегда', () => {
  it('час, минуты и секунды появляются по мере роста, секунды не пропадают', () => {
    expect(durationWords(0)).toBe('0 с')
    expect(durationWords(9)).toBe('9 с')
    expect(durationWords(60)).toBe('1 м 0 с')
    expect(durationWords(2943)).toBe('49 м 3 с')
    expect(durationWords(9614)).toBe('2 ч 40 м 14 с')
    expect(durationWords(3600)).toBe('1 ч 0 м 0 с')
    // Отрицательного времени не бывает — оно бы прочиталось как «идёт минус две минуты».
    expect(durationWords(-5)).toBe('0 с')
  })
})
