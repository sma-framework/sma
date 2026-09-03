/**
 * СТОЛБИК «ГОТОВО» — ПОРЯДОК, СИТО, АРХИВ И РАСКРЫТИЕ, ПРОВЕРЕННЫЕ КАК ПРОЕКЦИЯ.
 *
 * ЧТО ЗДЕСЬ ЧИНИЛОСЬ. Столбик закрытой работы показывал две строки и подписывал остальное
 * надписью «ещё N — свёрнуты»: раскрыть закрытое было нечем. Две видимые строки были при этом
 * не свежими, а самыми красными — общий порядок списка идёт по СОСТОЯНИЮ, а «не получилось»
 * стоит в нём выше «готово», — поэтому наверху висели срывы недельной давности, а принятые
 * работы лежали под счётчиком. Слова человека, которому это окно принадлежит: «почему они там
 * до сих пор висят и почему я до сих пор не могу раскрыть сделанные задачи и посмотреть их».
 *
 * ПОЧЕМУ ЭТО ТЕСТ О ПРОЕКЦИИ, А НЕ О ВЁРСТКЕ. Порядок, сито и архив считает `units.ts` — там же,
 * где живёт вся раскладка доски, — и разметка рисует их ответ. Порядок, живущий в вёрстке,
 * проверяется глазом и ровно поэтому расходится с правдой молча.
 *
 * Единицы строятся НАСТОЯЩИМ `buildUnits` из голых рядов двери и берутся из НАСТОЯЩЕГО столбика
 * `buildBoard`: единица, собранная руками, отвечала бы на вопрос из того самого допущения,
 * которое проверяется.
 */

import { describe, it, expect } from 'vitest'

import {
  ARCHIVE_AFTER_DAYS,
  DONE_PAGE,
  DONE_SHOWN,
  buildBoard,
  buildUnits,
  doneColumnTail,
  donePage,
  doneRowIndex,
  doneUnfoldRow,
  doneView,
  freshestFirst,
  inArchive,
} from '../../spa/src/screens/tasks/units'
import type { WorkUnit } from '../../spa/src/screens/tasks/units'
import type { DoneRow, PhaseIndexRow, PhaseStage, PhaseStageStatus } from '../../spa/src/api/types'

const NOW = Date.parse('2026-09-03T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

/** «столько-то дней назад» — отметкой двери, то есть строкой ISO, а не числом. */
const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString()

function doneRow(over: Partial<DoneRow> = {}): DoneRow {
  return {
    id: 'd1',
    title: 'Закрытая работа',
    project: 'sma',
    machine: 'm1',
    finishedAt: daysAgo(1),
    finishedDuration: null,
    workerId: null,
    attempts: 1,
    ...over,
  } as DoneRow
}

/** Пять стадий фазы — как их читает экран задач, в том же порядке. */
const STAGES: PhaseStage[] = ['discuss', 'plan', 'design', 'execute', 'verify']

/** Закрытая фаза: все стадии пройдены, значит её место — «Готово». */
function closedPhase(): PhaseIndexRow {
  return {
    id: '17.7',
    name: '17.7 Телефон',
    stages: Object.fromEntries(STAGES.map((s) => [s, 'done' as PhaseStageStatus])) as PhaseIndexRow['stages'],
    open: 0,
    answered: 0,
  }
}

/** Единицы столбика «Готово» — тем же путём, каким их кладёт туда экран. */
function doneColumn(done: DoneRow[], phases: PhaseIndexRow[] = []): WorkUnit[] {
  const units = buildUnits({
    queue: [],
    awaiting: [],
    workers: [],
    done,
    batches: [],
    phases,
    activeProject: 'sma',
    machine: '',
    selfMachine: 'm1',
    clock: () => '12:00',
    now: NOW,
  })
  return buildBoard(units).find((c) => c.key === 'done')?.units ?? []
}

const view = (done: DoneRow[], over: { tab?: 'all' | 'ok' | 'fail'; query?: string } = {}) =>
  doneView({ units: doneColumn(done), tab: over.tab ?? 'all', query: over.query ?? '', now: NOW })

/**
 * Провал, который столбик «ЖДУТ ВАС» НЕ забирает: очередь перевыдаст его сама. Ровно такой и
 * доезжает до «Готово», не будучи при этом закрытым рукой, — то есть годится проверять
 * порядок, а не архив.
 */
const failing = (over: Partial<DoneRow> = {}): DoneRow =>
  doneRow({
    id: 'd-fail',
    title: 'Оборвалась связь с провайдером',
    failed: {
      reason: 'provider_error',
      reasonLabel: 'Оборвал провайдер',
      attemptsCount: 1,
      repeats: { attempt: 1, of: 2 },
    },
    ...over,
  } as Partial<DoneRow>)

const accepted = (over: Partial<DoneRow> = {}): DoneRow =>
  doneRow({ id: 'd-ok', title: 'Свести отчёт по расходам', ...over })

describe('«Готово»: свежее сверху, а не красное сверху', () => {
  it('принятая работа, закрытая позже провала, стоит ВЫШЕ него', () => {
    const rows = [failing({ finishedAt: daysAgo(6) }), accepted({ finishedAt: daysAgo(0.04) })]

    // САМ СТОЛБИК ставит провал первым: общий порядок списка идёт по состоянию, и это ровно
    // тот дефект, ради которого проекция столбика и появилась. Утверждение здесь нарочно —
    // без него следующая строка не отличала бы починку от совпадения.
    expect(doneColumn(rows).map((u) => u.id)).toEqual(['d-fail', 'd-ok'])

    expect(view(rows).rows.map((u) => u.id)).toEqual(['d-ok', 'd-fail'])
  })

  it('строка без отметки закрытия уезжает вниз, а не наверх', () => {
    // О её времени не известно НИЧЕГО, и поставить такую первой значило бы объявить её самой
    // свежей — то есть выдать отсутствие замера за замер.
    const rows = [accepted({ id: 'd-nomark', title: 'Без отметки', finishedAt: null }), accepted({ finishedAt: daysAgo(2) })]
    expect(view(rows).rows.map((u) => u.id)).toEqual(['d-ok', 'd-nomark'])
  })

  it('порядок считается по отметке, а не по тому, в каком порядке ряды приехали', () => {
    const older = { id: 'a', finishedAt: daysAgo(3) } as Partial<DoneRow>
    const newer = { id: 'b', finishedAt: daysAgo(1) } as Partial<DoneRow>
    const units = doneColumn([accepted({ ...older, title: 'Старая' }), accepted({ ...newer, title: 'Новая' })])
    expect(freshestFirst(units).map((u) => u.id)).toEqual(['b', 'a'])
    expect(freshestFirst([...units].reverse()).map((u) => u.id)).toEqual(['b', 'a'])
  })
})

describe('«Готово»: сито «принято / не получилось» и поиск по названию', () => {
  const rows = [accepted({ finishedAt: daysAgo(1) }), failing({ finishedAt: daysAgo(2) })]

  it('вкладка «принято» показывает принятое, вкладка «не получилось» — провалы', () => {
    expect(view(rows, { tab: 'ok' }).rows.map((u) => u.id)).toEqual(['d-ok'])
    expect(view(rows, { tab: 'fail' }).rows.map((u) => u.id)).toEqual(['d-fail'])
  })

  it('числа на вкладках считаны по тем же строкам, что вкладки и показывают', () => {
    const v = view(rows)
    expect([v.ok, v.fail, v.total]).toEqual([1, 1, 2])
    expect(view(rows, { tab: 'ok' }).rows).toHaveLength(v.ok)
    expect(view(rows, { tab: 'fail' }).rows).toHaveLength(v.fail)
  })

  it('вкладки считают и архивное: «не получилось 0» над открытым архивом с провалом — неправда', () => {
    const stopped = doneRow({
      id: 'd-hand',
      title: 'Снятый дубль',
      failed: { reason: 'manual', reasonLabel: 'Остановлено вручную', attemptsCount: 1 },
    } as Partial<DoneRow>)
    const v = view([accepted(), stopped])
    expect(v.fail).toBe(1)
    expect(v.rows).toHaveLength(1)
    expect(v.archive).toHaveLength(1)
    // Вкладка «не получилось» показывает провал ТАМ, где он лежит, — в архиве, а не в столбике.
    const failsOnly = view([accepted(), stopped], { tab: 'fail' })
    expect(failsOnly.rows).toHaveLength(0)
    expect(failsOnly.archive.map((u) => u.id)).toEqual(['d-hand'])
    // …а вкладка «принято» архив не показывает вовсе: принятого в нём не бывает.
    expect(view([accepted(), stopped], { tab: 'ok' }).archive).toHaveLength(0)
  })

  it('поиск идёт по названию и не различает регистра', () => {
    expect(view(rows, { query: 'ОТЧЁТ' }).rows.map((u) => u.id)).toEqual(['d-ok'])
    expect(view(rows, { query: '  провайдер ' }).rows.map((u) => u.id)).toEqual(['d-fail'])
    // Слова, которых нет ни в одном названии, отвечают пустотой — но НЕ трогают счёт всего
    // закрытого: «ничего не нашлось» и «закрытой работы нет» — разные заявления.
    const none = view(rows, { query: 'такого названия нет' })
    expect(none.rows).toHaveLength(0)
    expect(none.total).toBe(2)
  })
})

describe('«Готово»: архив — то, о чём решение уже принято', () => {
  it('остановленное рукой уходит в архив, оставаясь на виду отдельной группой', () => {
    const stopped = doneRow({
      id: 'd-hand',
      title: 'Снятый дубль',
      finishedAt: daysAgo(0.1),
      failed: { reason: 'manual', reasonLabel: 'Остановлено вручную', attemptsCount: 1 },
    } as Partial<DoneRow>)
    const v = view([stopped, accepted()])

    expect(v.rows.map((u) => u.id)).toEqual(['d-ok'])
    expect(v.archive.map((u) => u.id)).toEqual(['d-hand'])
    // НЕ ИСЧЕЗЛА: слово о ней при ней и осталось.
    expect(v.archive[0].title).toBe('Снятый дубль')
    expect(v.archive[0].next).toContain('Остановлено вручную')
  })

  it('провал старше недели уходит в архив, а свежий остаётся в столбике', () => {
    const old = failing({ id: 'd-old', title: 'Старый срыв', finishedAt: daysAgo(ARCHIVE_AFTER_DAYS + 1) })
    const fresh = failing({ id: 'd-new', title: 'Свежий срыв', finishedAt: daysAgo(1) })
    const v = view([old, fresh])
    expect(v.rows.map((u) => u.id)).toEqual(['d-new'])
    expect(v.archive.map((u) => u.id)).toEqual(['d-old'])
  })

  it('принятая работа не уходит в архив никогда — сколько бы ей ни было', () => {
    // Столбик обещает человеку сделанное. Спрятать сделанное по возрасту значило бы ответить
    // «ничего не сделано» тому, кто не заходил месяц.
    const ancient = doneColumn([accepted({ finishedAt: daysAgo(400) })])
    expect(inArchive(ancient[0], NOW)).toBe(false)
    expect(view([accepted({ finishedAt: daysAgo(400) })]).archive).toHaveLength(0)
  })

  it('провал без отметки закрытия по возрасту не архивируется — возраста никто не мерил', () => {
    const nomark = doneColumn([failing({ finishedAt: null })])
    expect(inArchive(nomark[0], NOW)).toBe(false)
  })

  it('ни одна закрытая строка не теряется: столбик равен видимому плюс архив', () => {
    const rows = [
      accepted({ finishedAt: daysAgo(1) }),
      failing({ finishedAt: daysAgo(2) }),
      failing({ id: 'd-old', title: 'Старый срыв', finishedAt: daysAgo(30) }),
      doneRow({
        id: 'd-hand',
        title: 'Снятый дубль',
        failed: { reason: 'manual', reasonLabel: 'Остановлено вручную', attemptsCount: 1 },
      } as Partial<DoneRow>),
    ]
    const v = view(rows)
    const seen = [...v.rows, ...v.archive].map((u) => u.id).sort()
    expect(seen).toEqual(doneColumn(rows).map((u) => u.id).sort())
  })
})

describe('«Готово»: лента идёт страницами, а не одной стеной', () => {
  /** Столько принятых работ, сколько их лежит на живой машине: страница здесь не одна. */
  const many = (n: number): DoneRow[] =>
    Array.from({ length: n }, (_, i) =>
      accepted({ id: `d-${i}`, title: `Закрытая работа ${i}`, finishedAt: daysAgo((i + 1) / 24) }),
    )

  it('первая страница показывает страницу, а не весь список, и называет остаток', () => {
    const rows = view(many(DONE_PAGE * 4 + 3)).rows
    const first = donePage(rows, 1)
    expect(first.rows).toHaveLength(DONE_PAGE)
    expect(first.rest).toBe(rows.length - DONE_PAGE)
  })

  it('каждое нажатие добавляет ровно страницу, и последняя ничего не оставляет за собой', () => {
    const rows = view(many(DONE_PAGE * 2 + 5)).rows
    expect(donePage(rows, 2).rows).toHaveLength(DONE_PAGE * 2)
    const last = donePage(rows, 3)
    expect(last.rows).toHaveLength(rows.length)
    // Ни одна строка не остаётся недостижимой: кнопка исчезает ровно тогда, когда показано всё.
    expect(last.rest).toBe(0)
  })

  it('список короче страницы читается целиком и кнопки не получает', () => {
    const rows = view(many(3)).rows
    const only = donePage(rows, 1)
    expect(only.rows).toHaveLength(3)
    expect(only.rest).toBe(0)
  })

  it('архив листается той же страницей — свёрнутый архив не значит короткий', () => {
    const stopped = Array.from({ length: DONE_PAGE + 7 }, (_, i) =>
      doneRow({
        id: `d-hand-${i}`,
        title: `Снятый дубль ${i}`,
        finishedAt: daysAgo(i / 24),
        failed: { reason: 'manual', reasonLabel: 'Остановлено вручную', attemptsCount: 1 },
      } as Partial<DoneRow>),
    )
    const v = view(stopped)
    expect(v.archive).toHaveLength(DONE_PAGE + 7)
    expect(donePage(v.archive, 1).rows).toHaveLength(DONE_PAGE)
    expect(donePage(v.archive, 1).rest).toBe(7)
  })

  it('открытые страницы переживают обновление данных: окно — это ЧИСЛО страниц, а не запомненные строки', () => {
    // Опрос состояния приносит новый список каждые несколько секунд. Память, устроенная как
    // «последняя показанная строка», при таком обновлении либо теряет место, либо держит
    // строки, которых в новом ответе уже нет.
    const rows = many(DONE_PAGE * 3)
    const before = donePage(view(rows).rows, 2)
    expect(before.rows).toHaveLength(DONE_PAGE * 2)

    // …и вот оно, обновление: закрылась ещё одна работа, проекция пересчиталась целиком.
    const fresh = accepted({ id: 'd-fresh', title: 'Только что закрылась', finishedAt: daysAgo(0) })
    const after = donePage(view([...rows, fresh]).rows, 2)

    // Две страницы остались двумя — человек не вернулся к началу списка.
    expect(after.rows).toHaveLength(DONE_PAGE * 2)
    expect(after.rows[0].id).toBe('d-fresh')
    // …и из прочитанного вытеснена ровно одна строка — та, что новая сдвинула за край окна.
    const seen = new Set(after.rows.map((u) => u.id))
    expect(before.rows.filter((u) => seen.has(u.id))).toHaveLength(DONE_PAGE * 2 - 1)
  })
})

describe('«Готово»: подпись столбика называет то, чего на экране нет', () => {
  const stoppedRow = (i: number): DoneRow =>
    doneRow({
      id: `d-hand-${i}`,
      title: `Снятый дубль ${i}`,
      finishedAt: daysAgo(i + 1),
      failed: { reason: 'manual', reasonLabel: 'Остановлено вручную', attemptsCount: 1 },
    } as Partial<DoneRow>)

  it('при непустом архиве число считает и его: столбик рисует живое, а прячет и то, и другое', () => {
    const rows = [accepted({ finishedAt: daysAgo(0.1) }), stoppedRow(1), stoppedRow(2), stoppedRow(3)]
    const v = view(rows)
    const tail = doneColumnTail(v)

    // Видна ОДНА карточка: архивные в ленту столбика не идут вовсе.
    expect(tail.rows.map((u) => u.id)).toEqual(['d-ok'])
    // Скрыто ТРИ. Счёт «всё закрытое минус показанное» дал бы здесь два — при трёх спрятанных.
    expect(tail.hidden).toBe(3)
    expect(tail.label).toBe('ещё 3')
    expect(doneColumn(rows)).toHaveLength(4)
  })

  it('когда живого не осталось вовсе, столбик говорит это словами, а не пустотой', () => {
    const rows = [stoppedRow(1), stoppedRow(2), stoppedRow(3)]
    const tail = doneColumnTail(view(rows))
    expect(tail.rows).toHaveLength(0)
    // Пустота под заголовком «ГОТОВО 3» читается как поломка экрана — и человек прав.
    expect(tail.label).toBe('все 3 в архиве')
    expect(tail.hidden).toBe(3)
  })

  it('живых больше, чем помещается, — считаются и они, и архив', () => {
    const live = Array.from({ length: DONE_SHOWN + 4 }, (_, i) =>
      accepted({ id: `d-ok-${i}`, title: `Принятая ${i}`, finishedAt: daysAgo(i / 24) }),
    )
    const tail = doneColumnTail(view([...live, stoppedRow(1), stoppedRow(2)]))
    expect(tail.rows).toHaveLength(DONE_SHOWN)
    expect(tail.hidden).toBe(4 + 2)
    expect(tail.label).toBe('ещё 6')
  })

  it('показанное плюс скрытое равно столбику — при любом составе', () => {
    const rows = [
      accepted({ finishedAt: daysAgo(0.1) }),
      failing({ finishedAt: daysAgo(1) }),
      failing({ id: 'd-old', title: 'Старый срыв', finishedAt: daysAgo(ARCHIVE_AFTER_DAYS + 2) }),
      stoppedRow(1),
      stoppedRow(2),
    ]
    const tail = doneColumnTail(view(rows))
    expect(tail.rows.length + tail.hidden).toBe(doneColumn(rows).length)
  })

  it('когда всё закрытое помещается в столбик, подписи нет вовсе', () => {
    const tail = doneColumnTail(view([accepted({ finishedAt: daysAgo(0.1) })]))
    expect(tail.rows).toHaveLength(1)
    expect(tail.hidden).toBe(0)
    // Кнопка «ещё 0 — показать» обещает дверь туда, где ничего нет.
    expect(tail.label).toBeNull()
  })
})

describe('«Готово»: каждая строка раскрывается окном готовой работы', () => {
  it('и принятая, и провалившаяся раскрываются рядом двери — тем же, из которого построены', () => {
    const rows = [accepted(), failing()]
    const index = doneRowIndex(rows)
    const units = doneColumn(rows)
    expect(units).toHaveLength(2)

    for (const unit of units) {
      const row = doneUnfoldRow(unit, index)
      expect(row, `строка «${unit.title}» не раскрывается`).not.toBeNull()
      expect(row?.id).toBe(unit.id)
    }
    // Обе половины столбика названы явно: раскрытие, работающее только у зелёной строки,
    // оставляет красную немым прямоугольником — ровно тем, за которым человек идёт в терминал.
    expect(units.map((u) => u.state).sort()).toEqual(['fail', 'ok'])
  })

  it('архивная строка раскрывается так же — архив не отнимает у работы её истории', () => {
    const stopped = doneRow({
      id: 'd-hand',
      title: 'Снятый дубль',
      failed: { reason: 'manual', reasonLabel: 'Остановлено вручную', attemptsCount: 1 },
    } as Partial<DoneRow>)
    const v = view([stopped])
    expect(v.archive).toHaveLength(1)
    expect(doneUnfoldRow(v.archive[0], doneRowIndex([stopped]))?.id).toBe('d-hand')
  })

  it('закрытая фаза раскрытия не получает — её ряда в закрытой работе нет вовсе', () => {
    // Пустой ряд, выдуманный ради единообразия, показал бы «коммитов не найдено» и «кто принял
    // — не записано» о работе, которую никто и не спрашивал. Фаза открывается своей карточкой.
    const units = doneColumn([], [closedPhase()])
    const phase = units.find((u) => u.kind === 'phase')
    expect(phase).toBeDefined()
    expect(doneUnfoldRow(phase as WorkUnit, doneRowIndex([]))).toBeNull()
  })
})
