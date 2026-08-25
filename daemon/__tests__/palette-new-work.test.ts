/**
 * ТРИ ВИДА РАБОТЫ ИЗ ПАЛИТРЫ — И ЗАКОН, КОТОРЫЙ ЭТО НЕ ДОЛЖНО БЫЛО СЛОМАТЬ.
 *
 * Работа заводится тремя способами — задачей, батчем и фазой, — и человек, который открыл
 * палитру, должен найти там все три, а не один. Проверяется РЕЕСТР действий, а не вёрстка:
 * список статичен, у каждой строки есть дверь, и дверь — это значение, которое читается.
 *
 * Второе, и более важное: реестр палитры несёт в шапке закон — палитра ОТКРЫВАЕТ дверь и
 * никогда не нажимает кнопку. Новые строки — первый случай, когда дверь несёт с собой ещё и
 * поверхность экрана («разверни форму»), и ровно здесь закон мог бы тихо уехать. Поэтому
 * проверяется и он: ни одна дверь не зовёт хук, файл не знает про сетевой слой, а поверхность
 * — только та, которую окно готово развернуть.
 *
 * DOM не нужен: реестр и разбор просьбы — обычные значения, провода читаются как текст.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { SCREENS } from '../../spa/src/screens/registry'
import { readOpenScreen } from '../../spa/src/shell/navigation'
import { PALETTE_ACTIONS } from '../../spa/src/shell/palette-actions'

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** Строка реестра по её ключу — и внятная жалоба, если её там нет. */
function action(id: string) {
  const found = PALETTE_ACTIONS.find((a) => a.id === id)
  expect(found, `в реестре палитры нет строки «${id}»`).toBeTruthy()
  return found!
}

/** Куда ведёт строка — экран плюс поверхность, одной сравнимой парой. */
function doorOf(id: string): string {
  const door = action(id).door
  expect(door.via, `строка «${id}» ведёт не на экран`).toBe('screen')
  if (door.via !== 'screen') throw new Error('недостижимо')
  return `${door.screen}${door.opens ? `#${door.opens}` : ''}`
}

describe('палитра: три вида работы', () => {
  it('несёт ровно три строки о новой работе — задача, батч, фаза', () => {
    const titles = PALETTE_ACTIONS.map((a) => a.title)
    expect(titles).toContain('Новая задача')
    expect(titles).toContain('Новый батч')
    expect(titles).toContain('Новая фаза')
  })

  it('каждая ведёт на свой экран: задача и батч — на свою форму, фаза — на конвейер', () => {
    expect(doorOf('new-task')).toBe('tasks#new-task')
    expect(doorOf('new-batch')).toBe('tasks#new-batch')
    expect(doorOf('new-phase')).toBe('pipeline')
  })

  it('три двери — три РАЗНЫХ места: одна и та же дверь дважды была бы обманом строки', () => {
    const doors = ['new-task', 'new-batch', 'new-phase'].map(doorOf)
    expect(new Set(doors).size).toBe(doors.length)
  })

  it('дверь каждой строки реестра ведёт на существующий экран', () => {
    const known = new Set(SCREENS.map((s) => s.id))
    for (const a of PALETTE_ACTIONS) {
      if (a.door.via !== 'screen') continue
      expect(known, `строка «${a.id}» ведёт в никуда`).toContain(a.door.screen)
    }
  })

  it('у каждой строки есть подсказка — где эта кнопка живёт', () => {
    for (const a of PALETTE_ACTIONS) {
      expect(a.hint.trim().length, `строка «${a.id}» без подсказки`).toBeGreaterThan(0)
    }
  })

  it('ключи строк уникальны', () => {
    const ids = PALETTE_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('палитра открывает дверь, а не нажимает кнопку', () => {
  it('ни одна дверь реестра не зовёт хук: сегодня все двери — экраны', () => {
    expect(PALETTE_ACTIONS.every((a) => a.door.via === 'screen')).toBe(true)
  })

  it('реестр не знает про сетевой слой', () => {
    const src = readSource('../../spa/src/shell/palette-actions.ts')
    expect(src).not.toMatch(/from '\.\.\/api\//)
  })

  it('закон в шапке реестра не снят', () => {
    const src = readSource('../../spa/src/shell/palette-actions.ts')
    expect(src).toContain('THE PALETTE IS NOT A SECOND SURFACE OF RIGHTS')
    expect(src).toContain('opens the button instead of pressing it')
  })
})

describe('просьба развернуть форму доезжает до экрана', () => {
  it('палитра передаёт поверхность двери в просьбу об открытии', () => {
    const src = readSource('../../spa/src/shell/Palette.tsx')
    expect(src).toContain('openScreen({ screen: a.door.screen, opens: a.door.opens })')
  })

  it('экран «Задачи» разворачивает ту форму, которую попросили', () => {
    const src = readSource('../../spa/src/screens/tasks/index.tsx')
    expect(src).toContain('useOpenedWith')
    expect(src).toContain("openedWith?.opens === 'new-task'")
    expect(src).toContain("openedWith?.opens === 'new-batch'")
  })

  it('окно принимает названные поверхности и отбрасывает выдуманные', () => {
    const asked = (detail: unknown) => readOpenScreen({ detail } as unknown as Event)
    expect(asked({ screen: 'tasks', opens: 'new-task' })?.opens).toBe('new-task')
    expect(asked({ screen: 'tasks', opens: 'new-batch' })?.opens).toBe('new-batch')
    expect(asked({ screen: 'tasks', opens: 'выдуманное' })?.opens).toBeUndefined()
    expect(asked({ screen: 'tasks' })?.opens).toBeUndefined()
    expect(asked({ screen: 'такого-экрана-нет' })).toBeNull()
  })
})
