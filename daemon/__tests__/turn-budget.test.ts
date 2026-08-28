/**
 * ПОТОЛОК ХОДОВ ОТ РАЗМЕРА РАБОТЫ — И ОТ ТОГО, ЧТО УЖЕ СГОРЕЛО.
 *
 * ЧТО ЗДЕСЬ БЫЛО НЕ ТАК. Потолок был ОДНИМ числом на всё: правка одной строки и работа,
 * которая трогает несколько файлов и обязана доказать себя живым прогоном, шли под одним и
 * тем же. Вторая в это число не помещается физически, и две ночи подряд она в нём и сгорала —
 * сначала на умолчании, потом на удвоенном, — а следующая попытка каждый раз уходила с ТЕМ ЖЕ
 * потолком в ту же стену, оплаченная второй раз.
 *
 * ЧТО ЭТОТ ФАЙЛ УТВЕРЖДАЕТ. Три вещи, и все три — про арифметику, не про провод:
 *   (1) крупная работа получает больший потолок, чем мелкая, и признак размера СТРУКТУРНЫЙ —
 *       поля, которые очередь проверяет на входе, а не слова в описании;
 *   (2) после сгоревшего потолка следующий строго больше — либо его нет вовсе;
 *   (3) ходы считаются по РОДУ, а не одной кучей.
 * Провод от этих чисел до командной строки и до карточки — в `turn-cap-parks-wire.test.ts`.
 */

import { describe, it, expect } from 'vitest'

import {
  workSizeOf,
  taskTurnCap,
  burnedTurnCapsOf,
  turnKindOf,
  emptyTurnKinds,
  TURN_SIZE_MULTIPLIER,
  TURN_CAP_ESCALATION,
  TURN_CAP_MAX_MULTIPLIER,
} from '../src/policy/turn-budget.mjs'
import { DEFAULT_PIPELINE_MAX_TURNS } from '../src/config.mjs'

const BASE = DEFAULT_PIPELINE_MAX_TURNS // 80 — умолчание, которое горело первой ночью

/** Правка одной строки: без оценки, одно короткое обещание. */
const oneLiner = {
  id: 'R-1',
  source: 'roster',
  title: 'поправить одну строку',
  lane: 'prod',
  acceptance: 'тест зелёный',
}

/** Работа, которая обязана доказать себя прогоном: страница условий, несколько признаков. */
const bigWork = {
  id: 'R-2',
  source: 'roster',
  title: 'потолок ходов от размера работы',
  lane: 'prod',
  acceptance: [
    'потолок для работы, требующей прогона, выше, чем для однострочной правки'.padEnd(420, ' .'),
    'попытка после «ходов не хватило» не идёт с тем же потолком'.padEnd(420, ' .'),
    'на карточке исчерпанной работы три названных действия и число сожжённых ходов'.padEnd(420, ' .'),
    'разбивка ходов по роду видна в двери состояния'.padEnd(420, ' .'),
  ],
}

// ═══════════ (1) РАЗМЕР ═══════════════════════════════════════════════════════════════════

describe('потолок считается от размера работы, а не один на всё', () => {
  it('работе, требующей прогона, достаётся больше ходов, чем правке одной строки', () => {
    const small = taskTurnCap({ base: BASE, task: oneLiner })
    const large = taskTurnCap({ base: BASE, task: bigWork })

    expect(small.size).toBe('small')
    expect(large.size).toBe('large')
    expect(large.cap).toBeGreaterThan(small.cap as number)

    // И мелочь получает РОВНО то число, которое поставил человек: множитель мелкой работы —
    // единица, потому что настройка обязана остаться тем, чем её поставили.
    expect(small.cap).toBe(BASE)
    expect(large.cap).toBe(BASE * TURN_SIZE_MULTIPLIER.large)
  })

  /**
   * ПРИЗНАК ПРОВЕРЯЕМЫЙ, А НЕ СТРОКОВЫЙ ПОИСК ПО ОПИСАНИЮ — и это утверждается прямо.
   *
   * Соблазн был очевиден: увидел в тексте «живой прогон» — дал побольше. Тогда потолок
   * назначала бы ФОРМУЛИРОВКА, а не объём: одна и та же работа получала бы разный запас в
   * зависимости от того, какими словами её записали, а тот, кто нужного слова не написал,
   * платил бы за чужой стиль. Здесь задача, чьё ОПИСАНИЕ кричит про многофайловую работу с
   * живым прогоном, а обещание — одна короткая строка, читается как мелочь.
   */
  it('слова в описании потолка не поднимают — читаются только объявленные поля', () => {
    const loudButTiny = {
      ...oneLiner,
      description:
        'живой прогон обязателен, работа трогает несколько файлов, нужен ui-drive, ' +
        'запуск оболочки, полный сьют, много правок, крупная работа, поднять потолок ходов',
      note: 'живой прогон живой прогон живой прогон',
    }
    expect(workSizeOf(loudButTiny).size).toBe('small')
    expect(taskTurnCap({ base: BASE, task: loudButTiny }).cap).toBe(BASE)

    // А оценка человека — число, а не слово: та же короткая задача с оценкой 13 крупная.
    expect(workSizeOf({ ...oneLiner, storyPoints: 13 }).size).toBe('large')
  })

  it('признаки называются вслух, чтобы поднятый потолок не читался как произвол', () => {
    const { signals } = workSizeOf({ ...oneLiner, storyPoints: 5, acceptance: ['раз', 'два'] })
    expect(signals).toEqual({ storyPoints: 5, criteria: 2, promiseChars: 6 })
  })

  it('старший признак решает: большое обещание без оценки — крупная работа', () => {
    // Ровно тот случай, который сгорел: у роестровой работы нет оценки Фибоначчи вовсе, а
    // обещание у неё на страницу. Требуй мы согласия всех признаков — она читалась бы мелочью.
    const noEstimate = { ...bigWork, storyPoints: undefined }
    expect(workSizeOf(noEstimate).signals.storyPoints).toBeNull()
    expect(workSizeOf(noEstimate).size).toBe('large')
  })

  it('задача, о которой не объявлено ничего, получает базу — не запас, которого никто не просил', () => {
    expect(workSizeOf(null).size).toBe('small')
    expect(taskTurnCap({ base: BASE, task: undefined }).cap).toBe(BASE)
  })
})

// ═══════════ (2) ВТОРАЯ ПОПЫТКА ═══════════════════════════════════════════════════════════

describe('после сгоревшего потолка второй раз в ту же стену не ходят', () => {
  it('следующий потолок строго больше сгоревшего', () => {
    const next = taskTurnCap({ base: BASE, task: oneLiner, burnedCaps: [BASE] })
    expect(next.cap).toBeGreaterThan(BASE)
    expect(next.cap).toBe(BASE * TURN_CAP_ESCALATION)
    expect(next.escalatedFrom).toBe(BASE)
  })

  it('сгоревший потолок бьёт размер: мелкая работа, не влезшая в базу, тоже растёт', () => {
    // Размер сказал бы «мелочь, база»; сгоревшая база говорит «база уже проиграла».
    const sized = taskTurnCap({ base: BASE, task: oneLiner }).cap
    const after = taskTurnCap({ base: BASE, task: oneLiner, burnedCaps: [BASE] }).cap
    expect(sized).toBe(BASE)
    expect(after).toBeGreaterThan(sized as number)
  })

  it('самый щедрый из сгоревших решает, а не последний записанный', () => {
    const next = taskTurnCap({ base: BASE, task: oneLiner, burnedCaps: [BASE * 2, BASE] })
    expect(next.escalatedFrom).toBe(BASE * 2)
    expect(next.cap).toBeGreaterThan(BASE * 2)
  })

  it('у предела подъёмов ответа нет вовсе — это «не идти», а не «идти с тем же»', () => {
    const ceiling = BASE * TURN_CAP_MAX_MULTIPLIER
    const refused = taskTurnCap({ base: BASE, task: bigWork, burnedCaps: [ceiling] })
    expect(refused.cap).toBeNull()
    expect(refused.escalatedFrom).toBe(ceiling)
    expect(refused.ceiling).toBe(ceiling)
  })

  it('поднимают только те потолки, что сгорели ХОДАМИ, — чужая авария щедрости не даёт', () => {
    const rows = [
      { attempt: 1, failureReason: 'provider_error', turnCap: 240 },
      { attempt: 2, failureReason: 'liveness_killed', turnCap: 240 },
      { attempt: 3, failureReason: 'turns_exhausted', turnCap: 160 },
      { attempt: 4, outcome: 'completed', turnCap: 320 },
    ]
    expect(burnedTurnCapsOf(rows)).toEqual([160])
    expect(burnedTurnCapsOf(null)).toEqual([])
    // Строка без записанного потолка ничего не поднимает: поднимать не от чего.
    expect(burnedTurnCapsOf([{ failureReason: 'turns_exhausted' }])).toEqual([])
  })
})

// ═══════════ (3) НА ЧТО УШЛИ ХОДЫ ═════════════════════════════════════════════════════════

describe('ходы различаются по роду', () => {
  it('правка, запуск, чтение и прочее — четыре разных слова', () => {
    expect(turnKindOf('Edit')).toBe('edits')
    expect(turnKindOf('Write')).toBe('edits')
    expect(turnKindOf('Bash')).toBe('runs')
    expect(turnKindOf('BashOutput')).toBe('runs')
    expect(turnKindOf('Read')).toBe('reads')
    expect(turnKindOf('Grep')).toBe('reads')
  })

  it('незнакомый инструмент не притворяется знакомым', () => {
    expect(turnKindOf('WebFetch')).toBe('other')
    expect(turnKindOf('')).toBe('other')
    expect(turnKindOf(undefined as any)).toBe('other')
  })

  it('счётчик всегда несёт все четыре слова: ноль — это «не было», а не «неизвестно»', () => {
    expect(emptyTurnKinds()).toEqual({ edits: 0, runs: 0, reads: 0, other: 0 })
  })
})
