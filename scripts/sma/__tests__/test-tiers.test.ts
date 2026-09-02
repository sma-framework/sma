/**
 * Два яруса тестов и потолок потоков на один прогон.
 *
 * ЧТО ЗАМЕРЕНО И ПОЧЕМУ ЭТО ФАЙЛ, А НЕ ДОГОВОРЁННОСТЬ. Полный набор — 6000+ тестов, десятки
 * минут и настоящие дочерние процессы; по умолчанию vitest берёт под него столько рабочих,
 * сколько у машины потоков. Это верно ровно для одного прогона на пустой машине. Здесь
 * прогонов не один: четыре работника, сдающие работу одновременно, — это четыре полных
 * набора разом, и замер 02.09.2026 показал цену: полсотни процессов node, 0,2–0,3 ГБ
 * свободной памяти, процессор в полке. Проигрывали все четверо сразу, включая начавшего
 * первым.
 *
 * Лечение — два независимых куска, и оба проверяются здесь:
 *   1. ПОТОЛОК: один прогон берёт не больше трети потоков машины, и число это ВЫЧИСЛЕНО из
 *      процессора, а не вписано константой. Константа была бы правдой про ту машину, на
 *      которой её замерили, и молча стала бы удавкой или той же полкой на следующей.
 *   2. ДВА ЯРУСА: быстрый (юнит, без настоящих процессов, копий и Postgres — его гоняют по
 *      ходу работы) и полный (всё, один раз перед сдачей). Кто попал в быстрый ярус, решает
 *      ПРАВИЛО, читающее исходник самого теста, а не список имён, который начал бы врать с
 *      первого же нового живого теста.
 *
 * И ТРЕТЬЕ, РАДИ ЧЕГО ВСЁ ОСТАЛЬНОЕ НЕ ИМЕЕТ СМЫСЛА: глубина набора не изменилась. Быстрый
 * ярус — строгое ПОДМНОЖЕСТВО, а не замена: ни один файл не выпал из полного прогона, и
 * никакой тест не выключен ради скорости. Последняя проверка ниже краснеет, если полный
 * набор потерял хоть один файл дерева.
 *
 * ВЫЧИСЛЕНО ≠ ПОДКЛЮЧЕНО: правило и его число проверяются не сами по себе, а по тому, что
 * несёт СОБРАННЫЙ конфиг, который vitest действительно читает.
 */

import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

import fullConfig, {
  MACHINE_THREADS,
  RUN_MAX_WORKERS,
  SERIAL_SUITES,
  allSuites,
  isLiveSuite,
  unitSuites,
} from '../../../vitest.config.mjs'
import fastConfig from '../../../vitest.fast.config.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

type ProjectLike = { test?: { name?: string; include?: string[]; exclude?: string[] } }
const projectsOf = (cfg: unknown): ProjectLike[] =>
  ((cfg as { test?: { projects?: ProjectLike[] } }).test?.projects ?? []) as ProjectLike[]
const projectNamed = (cfg: unknown, name: string) =>
  projectsOf(cfg).find((p) => p.test?.name === name)

describe('потолок потоков на один прогон', () => {
  it('число рабочих выведено из процессора машины, а не вписано константой', () => {
    // Не «равно четырём»: на шестипоточной машине четыре — это снова полка, а на
    // тридцатидвухпоточной — удавка. Проверяется ПРАВИЛО, по которому число получено.
    expect(MACHINE_THREADS).toBe(availableParallelism())
    expect(RUN_MAX_WORKERS).toBe(Math.max(1, Math.floor(availableParallelism() / 3)))
  })

  it('потолок — не больше трети потоков, и никогда не ноль', () => {
    expect(RUN_MAX_WORKERS).toBeGreaterThanOrEqual(1)
    expect(RUN_MAX_WORKERS).toBeLessThanOrEqual(Math.ceil(MACHINE_THREADS / 3))
    // три прогона умещаются рядом — это и есть смысл трети
    expect(RUN_MAX_WORKERS * 3).toBeLessThanOrEqual(MACHINE_THREADS)
  })

  it('потолок ДОЕХАЛ до конфига, который читает vitest, — оба яруса', () => {
    expect((fullConfig as { test?: { maxWorkers?: number } }).test?.maxWorkers).toBe(RUN_MAX_WORKERS)
    expect((fastConfig as { test?: { maxWorkers?: number } }).test?.maxWorkers).toBe(RUN_MAX_WORKERS)
  })
})

describe('быстрый ярус — правило, а не список имён', () => {
  it('живой тест узнаётся по исходнику: настоящий процесс, очередь на Postgres', () => {
    expect(isLiveSuite("import { spawnSync } from 'node:child_process'")).toBe(true)
    expect(isLiveSuite("import PgBoss from 'pg-boss'")).toBe(true)
    expect(isLiveSuite("import { Client } from 'pg'")).toBe(true)
    expect(isLiveSuite("import { readFileSync } from 'node:fs'\nexpect(1).toBe(1)")).toBe(false)
  })

  it('в быстром ярусе нет ни одного файла последовательной группы', () => {
    const fast = new Set(unitSuites(ROOT))
    for (const serial of SERIAL_SUITES) expect(fast.has(serial), serial).toBe(false)
  })

  it('в быстром ярусе нет ни одного файла, который зовёт настоящий процесс', () => {
    for (const rel of unitSuites(ROOT)) {
      expect(isLiveSuite(readFileSync(join(ROOT, rel), 'utf8')), rel).toBe(false)
    }
  })

  it('быстрый ярус непуст и строго меньше полного — это подмножество, а не замена', () => {
    const all = new Set(allSuites(ROOT))
    const fast = unitSuites(ROOT)
    expect(fast.length).toBeGreaterThan(0)
    expect(fast.length).toBeLessThan(all.size)
    // ни одного теста, который живёт ТОЛЬКО в быстром ярусе: всё, что он гоняет,
    // полный набор гоняет тоже
    for (const rel of fast) expect(all.has(rel), rel).toBe(true)
  })

  it('быстрый ярус — отдельный конфиг, поэтому полный прогон не считает файлы дважды', () => {
    // `extends: true` СКЛАДЫВАЕТ include проектов: третий проект внутри основного конфига
    // прогнал бы пересечение дважды (замерено однажды: 263 файла вместо 134).
    expect((fastConfig as { test?: { projects?: unknown[] } }).test?.projects).toBeUndefined()
    const fastInclude = (fastConfig as { test?: { include?: string[] } }).test?.include ?? []
    expect(fastInclude).toEqual(unitSuites(ROOT))
  })
})

describe('глубина полного набора не изменилась', () => {
  it('полный прогон покрывает КАЖДЫЙ файл тестов дерева — ни один не выпал', () => {
    const parallel = projectNamed(fullConfig, 'parallel')
    const serial = projectNamed(fullConfig, 'serial')
    expect(parallel, 'параллельного проекта в конфиге нет').toBeDefined()
    expect(serial, 'последовательного проекта в конфиге нет').toBeDefined()

    const all = allSuites(ROOT)
    expect(all.length).toBeGreaterThan(0)

    // единственные файлы тестов продукта, исключённые из параллельного проекта, — это те,
    // что подобраны последовательным; всё остальное в exclude — глоба про node_modules
    const excludedProductFiles = (parallel!.test?.exclude ?? []).filter((p) => all.includes(p))
    expect(new Set(excludedProductFiles)).toEqual(new Set(serial!.test?.include ?? []))

    // и каждый файл последовательной группы существует на диске: строка, пережившая
    // переименование файла, тихо унесла бы его из прогона целиком
    for (const rel of SERIAL_SUITES) expect(all.includes(rel), rel).toBe(true)
  })
})

describe('обе двери названы там, где их ищут', () => {
  it('package.json несёт быстрый ярус и фильтр по задетым файлам', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['test:fast']).toContain('vitest.fast.config.mjs')
    expect(pkg.scripts['test:related']).toContain('vitest related')
    // полный набор остался тем же гейтом, каким был
    expect(pkg.scripts.test).toContain('vitest run')
    expect(pkg.scripts.test).toContain('badge.mjs --check')
  })

  it('роль исполнителя говорит про оба яруса словами, а не подразумевает их', () => {
    const role = readFileSync(join(ROOT, 'sma-core', 'agents', 'sma-executor.md'), 'utf8')
    expect(role).toContain('test:fast')
    expect(role).toContain('test:related')
    expect(role).toMatch(/full suite runs ONCE/i)
  })
})
