/**
 * ВОЗРАСТ ЧТЕНИЯ ДОЕЗЖАЕТ ДО ЭКРАНА — от файла окон до слов рядом с процентом.
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * 02.09.2026 доска говорила про недельное окно «67 %», а строка состояния терминала на той же
 * подписке — «7 %». Числу на доске было девятнадцать часов, и НИЧТО на экране этого не
 * сообщало: процент без часа читается как «сейчас». Человек, который видит два разных числа про
 * одну подписку и не может отличить свежее от вчерашнего, идёт перепроверять в терминал — то
 * есть ровно туда, откуда экран его и уводит.
 *
 * ═══════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════
 *
 *   1. МОМЕНТ СЪЁМКИ ЕДЕТ ПО ПРОВОДУ. Чтение кладётся в хранилище окон, читается моделью и
 *      выходит в выдаче `/api/state` полем `observedAt` — не вычисляется на экране из воздуха.
 *   2. ЭКРАН ГОВОРИТ ЭТОТ МОМЕНТ СЛОВАМИ. То самое поле, пропущенное через `readingAgeWords`,
 *      которым его рисует «Расходы», даёт «19 часов назад».
 *   3. СТАРШЕ ЧАСА — ПОМЕЧЕНО, и граница проходит там, где объявлена: свежее чтение не помечено,
 *      вчерашнее помечено.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: разметки самой ячейки — она живёт в `spa/src/screens/costs/WindowBars.tsx` и
 * читает ровно эти две функции. Здесь доказывается путь от хранилища до слов.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, afterEach } from 'vitest'

import { deriveState } from '../src/front/state.mjs'
import { markWindowObserved, windowState } from '../src/policy/windows.mjs'
import { readingAgeWords, readingIsStale, WINDOW_READING_STALE_MS } from '../../spa/src/shell/format'

const NOW = Date.parse('2026-09-02T12:40:00.000Z')
const WEEK_RESETS_AT = Date.parse('2026-09-06T15:00:00.000Z')

const tmps: string[] = []
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true })
})

function mkDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sma-window-age-'))
  tmps.push(dir)
  return dir
}

/** The spend row for the one account, off the same payload the screen polls. */
async function weekRow(dataDir: string) {
  const payload = await deriveState({
    adapter: { async list() { return [] } },
    windows: (account: unknown) => windowState({ account, clock: () => NOW, dataDir }),
    config: { workers: [{ id: 'local-1', lane: 'prod', account: { name: 'local-1' } }], machineId: 'self' },
    clock: () => NOW,
  })
  return payload.spend.accounts[0].week
}

describe('the age of a window reading, from the store to the words on the screen', () => {
  it('carries the moment a stale reading was taken, and the screen says «19 часов назад» — marked', async () => {
    const dataDir = mkDataDir()
    const takenAt = NOW - 19 * 60 * 60 * 1000

    markWindowObserved({
      dataDir,
      accountName: 'local-1',
      observation: { limitType: 'seven_day', status: 'allowed_warning', utilization: 0.67, resetsAt: WEEK_RESETS_AT },
      clock: () => takenAt,
    })

    const week = await weekRow(dataDir)
    expect(week.pct).toBe(67)
    // 1 — the moment travels; the screen is never left to guess it
    expect(week.observedAt).toBe(new Date(takenAt).toISOString())
    // 2 and 3 — and it is said in words, and marked
    expect(readingAgeWords(week.observedAt, NOW)).toBe('19 часов назад')
    expect(readingIsStale(week.observedAt, NOW)).toBe(true)
  })

  it('a reading taken minutes ago says so, and is not marked', async () => {
    const dataDir = mkDataDir()
    const takenAt = NOW - 2 * 60 * 1000

    markWindowObserved({
      dataDir,
      accountName: 'local-1',
      observation: { limitType: 'seven_day', status: 'allowed', utilization: 0.07, resetsAt: WEEK_RESETS_AT },
      clock: () => takenAt,
    })

    const week = await weekRow(dataDir)
    expect(week.pct).toBe(7)
    expect(readingAgeWords(week.observedAt, NOW)).toBe('2 мин назад')
    expect(readingIsStale(week.observedAt, NOW)).toBe(false)
  })

  /**
   * ═════ И ТА ЖЕ ДАТА — НА КАРТОЧКЕ РАБОТНИКА, а не только на «Расходах» ════════════════
   *
   * Час рядом с числом доехал сперва до одного экрана, и «Команда» осталась единственной, где
   * процент окна стоял голым. Это ровно та же болезнь в новом месте: карточка говорит
   * «принимает работу · 67 %», человек читает это как «сейчас» и идёт перепроверять в
   * терминал. Карточка читает НЕ спендовую строку, а `workers[].window` — свою ветку выдачи, —
   * поэтому она проверяется отдельно: одна ветка может нести момент съёмки, а другая молчать.
   */
  it('carries the moment onto the WORKER CARD too — its own branch of the payload, said in the same words', async () => {
    const dataDir = mkDataDir()
    const takenAt = NOW - 19 * 60 * 60 * 1000

    markWindowObserved({
      dataDir,
      accountName: 'local-1',
      observation: { limitType: 'seven_day', status: 'allowed_warning', utilization: 0.67, resetsAt: WEEK_RESETS_AT },
      clock: () => takenAt,
    })

    const payload: any = await deriveState({
      adapter: { async list() { return [] } },
      windows: (account: unknown) => windowState({ account, clock: () => NOW, dataDir }),
      config: { workers: [{ id: 'local-1', lane: 'prod', account: { name: 'local-1' } }], machineId: 'self' },
      clock: () => NOW,
    })

    const card = payload.workers[0].window
    expect(card.week.pct).toBe(67)
    expect(card.week.observedAt).toBe(new Date(takenAt).toISOString())
    expect(readingAgeWords(card.week.observedAt, NOW)).toBe('19 часов назад')
    expect(readingIsStale(card.week.observedAt, NOW)).toBe(true)
    // А окно, о котором не слышали, возраста не получает — и выдуманного тоже
    expect(card.fiveHour.observedAt).toBeNull()
    expect(readingAgeWords(card.fiveHour.observedAt, NOW)).toBeNull()
  })

  it('says the age in the counts Russian really uses, and marks exactly past the declared hour', () => {
    expect(readingAgeWords(new Date(NOW - 30_000).toISOString(), NOW)).toBe('только что')
    expect(readingAgeWords(new Date(NOW - 61 * 60 * 1000).toISOString(), NOW)).toBe('1 час назад')
    expect(readingAgeWords(new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), NOW)).toBe('3 часа назад')
    expect(readingAgeWords(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2 дня назад')
    // a window nothing was heard about has no age to state — and no invented one
    expect(readingAgeWords(null, NOW)).toBeNull()
    // clocks that disagree read as «now», never as a reading from the future
    expect(readingAgeWords(new Date(NOW + 5 * 60 * 1000).toISOString(), NOW)).toBe('только что')

    const edge = new Date(NOW - WINDOW_READING_STALE_MS).toISOString()
    expect(readingIsStale(edge, NOW)).toBe(false)
    expect(readingIsStale(new Date(NOW - WINDOW_READING_STALE_MS - 1000).toISOString(), NOW)).toBe(true)
    expect(readingIsStale(null, NOW)).toBe(false)
  })
})
