/**
 * ШАПКА ДОСКИ ЗАДАЧ О РАБОТНИКАХ — ЭТО ПРОВОД, А НЕ ВЫЧИСЛЕНИЕ.
 *
 * ПОВОД. Живой прогон окон 03.09.2026 застал на одном экране два разных ответа на один вопрос:
 * шапка доски задач говорила «Работников: 46 · занято 3», а «Агенты» рядом — «3 работника в
 * очереди», «Команда» — «занято 3 из 3 мест», и сама дверь состояния в той же выдаче несла
 * `kpis.workersTotal = 3`. Сорок три лишних — выключенные специалисты, которых очередь не
 * раздаёт вовсе: шапка считала работников ДЛИНОЙ СПИСКА ролей. Тот же класс на стороне двери
 * уже лечили («доска говорила „работников 44“, когда задачи разбирали шестеро»), и починка
 * дошла до чисел двери, но не до этой шапки — ровно потому, что шапка считала сама.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. Не «функция считает правильно», а ЧТО ЧИСЛО ДОЕЗЖАЕТ: настоящая
 * дверь состояния собирает выдачу из настоящего состава машины, и предложение шапки строится
 * из ЭТОЙ выдачи той же функцией, которую зовёт экран. Между ними нет второго мнения о том,
 * кто здесь работник, — и именно это утверждается: пока `kpis` и шапка выведены из одного
 * места, разойтись им нечем.
 *
 * ПОЧЕМУ СОСТАВ ИМЕННО ТАКОЙ. Три исполнителя и сорок три выключенных специалиста — это тот
 * самый состав, на котором дефект и был виден: пока список короток и весь включён, длина списка
 * и пул очереди совпадают, и подделка проходит незамеченной.
 *
 * Ни демона, ни базы, ни сети: очередь подставная, состав — обычный объект настроек.
 */

import { describe, it, expect } from 'vitest'

import { deriveState } from '../src/front/state.mjs'
import { rosterLine } from '../../spa/src/screens/tasks/units'

const NOW = 1_777_000_000_000

/** Очередь, отдающая ровно то, что ей дали. Дверь состояния читает у неё только list(). */
const mkAdapter = (rows: any[]) => ({
  async list() {
    return rows
  },
})

/** Окна: ни про один счёт ничего не известно — это дело не про окна. */
const windows = () => ({})

/**
 * Состав машины: `executors` исполнителей и `specialists` выключенных специалистов.
 * Специалисты названы ролями (`ai-researcher`, …) — их поднимает фаза поимённо, а очередь
 * не раздаёт; именно они и раздували число в шапке.
 */
const roster = (executors: number, specialists: number) => [
  ...Array.from({ length: executors }, (_, i) => ({
    id: `max-${i + 1}`,
    lane: 'prod',
    account: { name: `max-${i + 1}` },
  })),
  ...Array.from({ length: specialists }, (_, i) => ({
    id: `specialist-${i + 1}`,
    lane: 'research',
    role: `sma-specialist-${i + 1}`,
    enabled: false,
    account: { name: 'max-1' },
  })),
]

const door = (workers: any[], rows: any[] = []) =>
  deriveState({
    adapter: mkAdapter(rows),
    windows,
    config: { workers, pipeline: { enabled: true } },
    clock: () => NOW,
  })

describe('шапка доски задач называет работниками пул очереди, а не весь состав ролей', () => {
  it('три работника и сорок три выключенных специалиста — шапка говорит «3», а не «46»', async () => {
    const claimed = {
      id: 'R-1',
      status: 'claimed',
      lane: 'prod',
      title: 'взята',
      workerId: 'max-1',
      claimedAt: NOW - 2000,
      leaseRenewedAt: NOW - 2000,
    }
    const payload: any = await door(roster(3, 43), [claimed])

    // Состав ДЕЙСТВИТЕЛЬНО длинный — иначе дело доказывало бы согласие с самим собой.
    expect(payload.workers.length, 'весь состав ролей приезжает на экран целиком').toBe(46)
    expect(payload.kpis.workersTotal).toBe(3)
    expect(payload.kpis.workersBusy).toBe(1)

    const line = rosterLine(payload)
    expect(line).toBe('Работников: 3 · занято 1')
    // И прежнее выражение шапки здесь именно ВРЁТ: длина списка сказала бы «46».
    expect(line).not.toContain(String(payload.workers.length))
  })

  it('число в шапке ДВИЖЕТСЯ вместе с числами двери — это провод, а не совпадение', async () => {
    const six: any = await door(roster(6, 43))
    expect(six.kpis.workersTotal).toBe(6)
    expect(rosterLine(six)).toBe(`Работников: ${six.kpis.workersTotal} · занято ${six.kpis.workersBusy}`)
  })

  it('единственный работник назван поимённо — и это работник, а не первый в списке ролей', async () => {
    // Специалисты стоят ПЕРВЫМИ, поэтому `workers[0]` назвал бы работником специалиста.
    const workers = [...roster(0, 43), ...roster(1, 0)]
    const payload: any = await door(workers)

    expect(payload.workers[0].id).toBe('specialist-1')
    expect(payload.kpis.workersTotal).toBe(1)
    expect(rosterLine(payload)).toBe(`Работник: max-1 · ${payload.workers.at(-1).presence}`)
  })

  it('до первого ответа двери шапка говорит, что читает, — а не «работников нет»', () => {
    expect(rosterLine(undefined)).toBe('Работники — читаю…')
  })

  it('состав без единого исполнителя — «работников нет», и это измерение', async () => {
    const payload: any = await door(roster(0, 43))
    expect(payload.kpis.workersTotal).toBe(0)
    expect(rosterLine(payload)).toBe('Работников нет')
  })
})
