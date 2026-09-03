/**
 * ГЛАВНЫЕ ЗАКРЫТИЯ НОЧИ НЕ ВИДНЫ НА «СЕГОДНЯ»: СТРОКА БЕЗ ПРОЕКТА И СИТО, КОТОРОЕ О НЕЙ МОЛЧАЛО.
 *
 * ═══════════════ ЧТО БЫЛО НЕ ТАК ═══════════════
 *
 * Основатель сказал это словами 01.09: «почему-то до сих пор не вижу все готовые задачи».
 * ЗАМЕРЕНО в тот же вечер: в `done[]` двери состояния лежало 46 строк, сито экрана «Сегодня»
 * пропускало 32 (`project:sma`), а 14 несли `project:null` и по устройству сита не проходили —
 * среди спрятанных были ВСЕ флагманы смены. Бесхозные строки рождались на постановке: скан
 * реестра ЗНАЕТ, чей `BACKLOG.md` он читает, и всё равно ставил задачу без владельца.
 *
 * Две половины одного дефекта, и здесь проверяются обе — на НАСТОЯЩИХ модулях продукта:
 *
 *   1. СТРОКА ИЗ СКАНА НЕСЁТ ПРОЕКТ, и потому доезжает до экрана. Настоящий `scanBacklog`
 *      читает реестр, настоящий `deriveState` собирает из закрытой строки `done[]`, настоящее
 *      сито `ofProject` её ОСТАВЛЯЕТ. Уберите штамп на постановке — и та же самая работа
 *      исчезает с экрана: ровно то, что случилось со сменой 31.08.
 *   2. ГОТОВОЕ БЕЗ ПРОЕКТА НЕ ИСЧЕЗАЕТ БЕЗ СЛЕДА. Сито остаётся фильтром одного проекта (это
 *      решение, и оно записано в коде), но отброшенное за отсутствие владельца считается и
 *      называется числом со ссылкой на экран «Задачи». Ноль — молчит: беды, которой нет,
 *      экран не выдумывает. Строка ЧУЖОГО проекта в это число не попадает: она спрятана по
 *      делу и видна на своём месте.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: как выглядит эта строка на экране (это разметка) и что делает сама дверь
 * приёмки. Здесь только путь от постановки до того, что человек утром видит и не видит.
 */

import { readFileSync } from 'node:fs'

import { describe, it, expect } from 'vitest'

import { scanBacklog } from '../src/intake/backlog-scan.mjs'
import { deriveState } from '../src/front/state.mjs'
import { closedWords, ofProject, orphanNote, orphansOf } from '../../spa/src/screens/today/orphans'

const NOW = 1_700_003_600_000
const PROJECT = 'sma'

const config = { agingHours: 24, workers: [{ id: 'max-1', lane: 'prod', account: { name: 'max-1' } }] }
const win = (state: string) => ({ state, usedPct: null, resetAt: null })
const windows = () => ({ fiveHour: win('open'), week: win('open') })

/** Настоящий реестр в трёх строках: столько, сколько нужно, чтобы скан выдал задачу. */
const BACKLOG = [
  '## Backlog',
  '- [ ] **R-186** · Сведение веток перед сдачей — делает работник, а не приёмщик. `size:M` `sp:3`',
  '- [ ] **R-189** · Возврат несёт нагрузку целиком — дверь не собирает задачу из строк. `size:S` `sp:2`',
].join('\n')

const scanOf = (extra: Record<string, unknown> = {}) =>
  scanBacklog({
    repoDir: '/repo',
    execGit: (args: string[]) => (args[0] === 'log' ? '1700000000\n' : ''),
    clock: () => NOW,
    fsImpl: { readFileSync: () => BACKLOG },
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

/** Закрытая строка очереди в том виде, в каком её отдаёт адаптер. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const completed = (task: any) => ({
  id: task.id,
  status: 'completed',
  lane: task.lane ?? 'prod',
  title: task.title,
  attempt: 1,
  workerId: 'max-1',
  completedAt: NOW - 60_000,
  ...(task.project ? { project: task.project } : {}),
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const derive = async (rows: any[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await deriveState({
    adapter: { list: async () => rows.map((r) => ({ ...r })) },
    ledger: () => [],
    windows,
    config,
    clock: () => NOW,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any

describe('строка из скана доезжает до «Сегодня», потому что несёт проект', () => {
  it('со штампом реестра работа видна на экране проекта; без штампа та же работа исчезает', async () => {
    const stamped = await scanOf({ project: PROJECT })
    expect(stamped.items.length).toBeGreaterThan(0)

    const state = await derive(stamped.items.map(completed))
    // Дверь состояния отдала ту же работу закрытой и с владельцем — не «неизвестен».
    expect(state.done.length).toBe(stamped.items.length)
    expect(state.done.every((r: { project: string | null }) => r.project === PROJECT)).toBe(true)
    // И сито экрана её ОСТАВЛЯЕТ: это и есть «вижу все готовые задачи».
    expect(ofProject(state.done, PROJECT).length).toBe(stamped.items.length)
    expect(orphansOf(state.done, PROJECT)).toEqual([])
    expect(orphanNote(orphansOf(state.done, PROJECT).length)).toBeNull()

    // ТА ЖЕ САМАЯ РАБОТА, поставленная без штампа, — вечер 31.08 целиком.
    const bare = await scanOf()
    const blind = await derive(bare.items.map(completed))
    expect(blind.done.every((r: { project: string | null }) => r.project === null)).toBe(true)
    expect(ofProject(blind.done, PROJECT)).toEqual([])
  })
})

describe('готовое без проекта не исчезает с «Сегодня» без следа', () => {
  it('сито остаётся фильтром одного проекта, но отброшенное за бесхозность названо числом', async () => {
    const rows = [
      // Своё — его человек и видит карточками.
      { ...completed({ id: 'R-199', title: 'своя работа', project: PROJECT }) },
      { ...completed({ id: 'R-201', title: 'вторая своя', project: PROJECT }) },
      // Бесхозное — сито выбрасывает, и вот об этом экран обязан сказать.
      { ...completed({ id: 'R-178', title: 'флагман смены' }) },
      { ...completed({ id: 'R-180', title: 'второй флагман' }) },
      { ...completed({ id: 'R-195', title: 'третий флагман' }) },
      // Чужое — спрятано по делу: у него есть свой экран, и в счёт бесхозного оно не идёт.
      { ...completed({ id: 'R-300', title: 'работа соседнего проекта', project: 'other' }) },
    ]
    const state = await derive(rows)
    expect(state.done.length).toBe(6)

    const shown = ofProject(state.done, PROJECT)
    const hidden = orphansOf(state.done, PROJECT)
    expect(shown.map((r: { id: string }) => r.id)).toEqual(['R-199', 'R-201'])
    expect(hidden.map((r: { id: string }) => r.id)).toEqual(['R-178', 'R-180', 'R-195'])
    // Чужой проект — не бесхозность: он не в счёте и не в показе.
    expect(hidden.some((r: { id: string }) => r.id === 'R-300')).toBe(false)

    const words = orphanNote(hidden.length)
    expect(words).toBe('ещё 3 готовые без проекта — экран «Задачи»')
  })

  it('число согласовано со счётом ночи: 46 закрытых, 32 показаны, 14 названы', () => {
    const rows = [
      ...Array.from({ length: 32 }, (_, i) => ({ id: `own-${i}`, project: PROJECT })),
      ...Array.from({ length: 14 }, (_, i) => ({ id: `bare-${i}`, project: null })),
    ]
    expect(rows.length).toBe(46)
    expect(ofProject(rows, PROJECT).length).toBe(32)
    expect(orphansOf(rows, PROJECT).length).toBe(14)
    expect(orphanNote(14)).toBe('ещё 14 готовых без проекта — экран «Задачи»')
  })

  it('о том, чего нет, экран молчит: ноль бесхозных — ни строки, ни числа', () => {
    expect(orphanNote(0)).toBeNull()
    expect(orphanNote(-1)).toBeNull()
    expect(orphanNote(Number.NaN)).toBeNull()
    // Проект не выбран — сита нет вовсе, значит и отброшенного нет.
    expect(orphansOf([{ id: 'x', project: null }], null)).toEqual([])
    expect(ofProject([{ id: 'x', project: null }], null).length).toBe(1)
  })

  it('слово по-русски согласовано с числом — иначе строку читают дважды', () => {
    expect(orphanNote(1)).toBe('ещё 1 готовая без проекта — экран «Задачи»')
    expect(orphanNote(2)).toBe('ещё 2 готовые без проекта — экран «Задачи»')
    expect(orphanNote(5)).toBe('ещё 5 готовых без проекта — экран «Задачи»')
    expect(orphanNote(11)).toBe('ещё 11 готовых без проекта — экран «Задачи»')
  })
})

/**
 * ЗАГОЛОВОК НОЧИ И ЛЕНТА ПОД НИМ ГОВОРЯТ ОБ ОДНОЙ И ТОЙ ЖЕ НОЧИ.
 *
 * Строка-счёт под лентой появилась раньше заголовка, и какое-то время экран спорил сам с собой
 * в трёх сантиметрах по вертикали: наверху «команда закрыла N задач» — по ПРОСЕЯННОМУ списку,
 * внизу «ещё столько-то готовых без проекта». Занижение было ровно на число, названное строкой
 * под ним, и первым читается как раз заголовок.
 *
 * Здесь проверяется весь провод, а не фраза: настоящая дверь состояния собирает `done[]`,
 * настоящее сито делит его на своё и бесхозное, и уже по этим двум числам складывается итог.
 */
describe('заголовок «Сегодня» считает всю закрытую ночь, а не только просеянную', () => {
  it('две готовые строки проекта и одна готовая без проекта — в заголовке 3, и 1 из них названа бесхозной', async () => {
    const state = await derive([
      completed({ id: 'own-1', title: 'своя работа', project: PROJECT }),
      completed({ id: 'own-2', title: 'вторая своя', project: PROJECT }),
      completed({ id: 'bare-1', title: 'готово без владельца' }),
    ])

    const shown = ofProject(state.done, PROJECT).filter((r: { failed?: unknown }) => !r.failed)
    const bare = orphansOf(state.done, PROJECT).filter((r: { failed?: unknown }) => !r.failed)
    expect(shown.length).toBe(2)
    expect(bare.length).toBe(1)

    const words = closedWords(shown.length, bare.length)
    // Число — обо всей ночи: две карточки на экране плюс одна, о которой сказано словами.
    expect(words).toBe('Пока вас не было, команда закрыла 3 задачи, из них 1 без проекта')
    expect(words).toContain('1 без проекта')
  })

  it('сгоревшая работа в итог не идёт — ни своя, ни бесхозная: «закрыла» о ней неправда', async () => {
    const state = await derive([
      completed({ id: 'own-1', title: 'своя работа', project: PROJECT }),
      { ...completed({ id: 'own-2', title: 'своя сгоревшая', project: PROJECT }), status: 'failed' },
      completed({ id: 'bare-1', title: 'готово без владельца' }),
      { ...completed({ id: 'bare-2', title: 'сгорело без владельца' }), status: 'failed' },
    ])

    const shown = ofProject(state.done, PROJECT).filter((r: { failed?: unknown }) => !r.failed)
    const bare = orphansOf(state.done, PROJECT).filter((r: { failed?: unknown }) => !r.failed)
    expect(closedWords(shown.length, bare.length)).toBe(
      'Пока вас не было, команда закрыла 2 задачи, из них 1 без проекта',
    )
  })

  it('бесхозных нет — фраза остаётся ровно прежней: оговорка о беде, которой нет, сама беда', async () => {
    const state = await derive([
      completed({ id: 'own-1', title: 'своя работа', project: PROJECT }),
      completed({ id: 'own-2', title: 'вторая своя', project: PROJECT }),
      // Чужой проект спрятан по делу и в счёт бесхозного не идёт — значит и в оговорку тоже.
      completed({ id: 'alien-1', title: 'работа соседнего проекта', project: 'other' }),
    ])

    const shown = ofProject(state.done, PROJECT).filter((r: { failed?: unknown }) => !r.failed)
    const bare = orphansOf(state.done, PROJECT).filter((r: { failed?: unknown }) => !r.failed)
    expect(bare.length).toBe(0)
    expect(closedWords(shown.length, bare.length)).toBe('Пока вас не было, команда закрыла 2 задачи')
  })

  it('слово согласовано с числом, а мусор вместо числа читается нулём', () => {
    expect(closedWords(1, 0)).toBe('Пока вас не было, команда закрыла 1 задачу')
    expect(closedWords(0, 1)).toBe('Пока вас не было, команда закрыла 1 задачу, из них 1 без проекта')
    expect(closedWords(4, 1)).toBe('Пока вас не было, команда закрыла 5 задач, из них 1 без проекта')
    expect(closedWords(20, 2)).toBe('Пока вас не было, команда закрыла 22 задачи, из них 2 без проекта')
    expect(closedWords(0, 0)).toBe('Пока вас не было, команда закрыла 0 задач')
    expect(closedWords(Number.NaN, -3)).toBe('Пока вас не было, команда закрыла 0 задач')
  })

  it('число согласовано со счётом ночи: 32 показаны, 14 названы, в заголовке — 46', () => {
    const rows = [
      ...Array.from({ length: 32 }, (_, i) => ({ id: `own-${i}`, project: PROJECT })),
      ...Array.from({ length: 14 }, (_, i) => ({ id: `bare-${i}`, project: null })),
    ]
    const shown = ofProject(rows, PROJECT).length
    const bare = orphansOf(rows, PROJECT).length
    expect(closedWords(shown, bare)).toBe('Пока вас не было, команда закрыла 46 задач, из них 14 без проекта')
  })
})

describe('провод: экран считает бесхозное тем же модулем, что и просеивает', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('сито и счёт приходят из одного модуля, а лента получает число пропом', () => {
    const screen = read('../../spa/src/screens/today/index.tsx')
    const feed = read('../../spa/src/screens/today/DayFeed.tsx')

    // Экран не держит второго сита: и показ, и счёт отброшенного берутся здесь.
    expect(screen).toContain("from './orphans'")
    expect(screen).toContain('ofProject(rows, activeProject)')
    expect(screen).toContain('orphansOf(data?.done ?? [], activeProject)')
    expect(screen).toContain('orphanFinished={orphanFinished}')
    // И заголовок — из того же модуля: собственная фраза в разметке разошлась бы со строкой
    // под лентой на следующей же правке одной из них.
    expect(screen).toContain('closedWords(finished.length, orphanFinished)')

    // Лента слова не сочиняет — она печатает то, что сказал модуль.
    expect(feed).toContain("from './orphans'")
    expect(feed).toContain('orphanNote(count)')
  })
})
