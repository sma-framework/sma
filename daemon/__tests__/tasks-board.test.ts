/**
 * РАСКЛАДКА ПО СТОЛБИКАМ — ПРОВЕРЯЕТСЯ КАК ПРОЕКЦИЯ, А НЕ ГЛАЗОМ ПО ВЁРСТКЕ.
 *
 * Экран задач раскладывает работу по шести столбикам: четыре стадии, «ЖДУТ ВАС» и «Готово».
 * Раскладка эта — чистая функция над единицами (`columnOf` / `buildBoard` / `countColumns`),
 * и живёт она в `units.ts` именно затем, чтобы её можно было утверждать прогоном. Столбик, чья
 * принадлежность записана только в разметке, проверяется взглядом человека — и ровно поэтому
 * расходится с правдой молча: никто не заметит, что фаза со стадией «Проверка» второй месяц
 * стоит в «Исполнении».
 *
 * Здесь проверяется ТРИ утверждения, каждое из которых экран обещает человеку:
 *   1. фаза стоит в столбике СВОЕЙ стадии — стадия N и есть столбик N;
 *   2. всё, что ждёт человека (`dec`), стоит в «ЖДУТ ВАС», чем бы оно ни было занято;
 *   3. счётчики шапки посчитаны по тем же единицам, что лежат в столбиках, — иначе первое же
 *      расхождение числа и содержимого человек прочитает как ошибку экрана.
 *
 * Единицы строятся НАСТОЯЩИМ `buildUnits` из голых рядов двери, а не собираются руками:
 * подделанная единица отвечала бы на вопрос из того самого допущения, которое проверяется.
 */

import { describe, it, expect } from 'vitest'

import {
  BOARD_COLUMNS,
  buildBoard,
  buildUnits,
  columnOf,
  countColumns,
} from '../../spa/src/screens/tasks/units'
import type { BoardColumn } from '../../spa/src/screens/tasks/units'
import type {
  BatchRow,
  DoneRow,
  PhaseIndexRow,
  PhaseStage,
  PhaseStageStatus,
  QueueRow,
  WorkerRow,
} from '../../spa/src/api/types'

// ЕЩЁ ОДНА РУКОПИСНАЯ КОПИЯ ДОРОГИ — своя, потому что список стадий экрана задач модулю-соседу
// не виден. Она обязана совпадать с ним ровно и в том же порядке: пары «стадия N ↔ столбик N»
// ниже строятся по индексу, и список короче настоящего сдвинул бы каждую пару молча.
const STAGES: PhaseStage[] = ['discuss', 'plan', 'design', 'execute', 'verify']

/** Ряд указателя фаз с названными стадиями — остальное умолчаниями двери. */
function phaseRow(
  stages: Partial<Record<PhaseStage, PhaseStageStatus>>,
  open = 0,
  id = 'p1',
): PhaseIndexRow {
  return {
    id,
    name: '17.7 Телефон',
    stages: { discuss: 'none', plan: 'none', execute: 'none', verify: 'none', ...stages },
    open,
    answered: 0,
  }
}

function queueRow(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 't1',
    title: 'Задача',
    lane: null,
    project: 'sma',
    machine: 'm1',
    priority: 0,
    status: 'queued',
    position: 1,
    ...over,
  } as QueueRow
}

/** Единицы, построенные тем же путём, каким их строит экран. */
function units(input: {
  queue?: QueueRow[]
  awaiting?: QueueRow[]
  workers?: WorkerRow[]
  done?: DoneRow[]
  batches?: BatchRow[]
  phases?: PhaseIndexRow[]
}) {
  return buildUnits({
    queue: input.queue ?? [],
    awaiting: input.awaiting ?? [],
    workers: input.workers ?? [],
    done: input.done ?? [],
    batches: input.batches ?? [],
    phases: input.phases ?? [],
    activeProject: 'sma',
    machine: '',
    selfMachine: 'm1',
    clock: () => '12:00',
    now: 1_000_000,
  })
}

/** В каком столбике лежит ЕДИНСТВЕННАЯ единица — читается через доску, а не через `columnOf`. */
function whereSingle(us: ReturnType<typeof units>): BoardColumn {
  expect(us).toHaveLength(1)
  const col = buildBoard(us).find((c) => c.units.length === 1)
  expect(col).toBeDefined()
  return (col as { key: BoardColumn }).key
}

describe('фаза стоит в столбике своей стадии', () => {
  it.each(STAGES.map((stage, i) => [stage, BOARD_COLUMNS[i]] as const))(
    'идущая стадия «%s» ставит фазу в столбик «%s»',
    (stage, column) => {
      // Пройденные стадии — все, что стоят ЛЕВЕЕ идущей: так фаза и выглядит на диске.
      const before = STAGES.slice(0, STAGES.indexOf(stage))
      const stages = Object.fromEntries([
        ...before.map((s) => [s, 'done' as PhaseStageStatus]),
        [stage, 'in-progress' as PhaseStageStatus],
      ])
      expect(whereSingle(units({ phases: [phaseRow(stages)] }))).toBe(column)
    },
  )

  it.each(STAGES.map((stage, i) => [stage, BOARD_COLUMNS[i]] as const))(
    'первая НЕпройденная стадия «%s» тоже ставит фазу в столбик «%s»',
    (stage, column) => {
      // Ни одна стадия не запущена: фаза стоит там, куда ей идти дальше, — и говорит об этом
      // своим словом, а не переездом в чужой столбик.
      const before = STAGES.slice(0, STAGES.indexOf(stage))
      const stages = Object.fromEntries(before.map((s) => [s, 'done' as PhaseStageStatus]))
      expect(whereSingle(units({ phases: [phaseRow(stages)] }))).toBe(column)
    },
  )

  it('все стадии пройдены — фаза в «Готово»', () => {
    const all = Object.fromEntries(STAGES.map((s) => [s, 'done' as PhaseStageStatus]))
    expect(whereSingle(units({ phases: [phaseRow(all)] }))).toBe('done')
  })

  it('открытый вопрос уводит фазу в «ЖДУТ ВАС» с любой стадии', () => {
    // Стадия «Исполнение» ИДЁТ — и всё же фаза стоит на человеке: работа, которая ждёт его
    // слова, не должна отыскиваться среди движущейся. В этом весь смысл столбика.
    const us = units({ phases: [phaseRow({ discuss: 'done', plan: 'done', execute: 'in-progress' }, 2)] })
    expect(whereSingle(us)).toBe('you')
    expect(us[0].wait?.what).toContain('к вам')
    expect(us[0].wait?.cta).toBeTruthy()
  })
})

describe('инлайн и батч стадий не имеют — их кладёт состояние', () => {
  it('инлайн, ждущий решения человека, — в «ЖДУТ ВАС», и несёт слова ожидания', () => {
    const us = units({ awaiting: [queueRow({ status: 'awaiting_approval', agedForHours: 0.7 })] })
    expect(whereSingle(us)).toBe('you')
    expect(us[0].state).toBe('dec')
    expect(us[0].wait?.age).toBe('42 МИН')
    expect(us[0].wait?.what).toContain('приёмке')
  })

  it('инлайн в очереди и инлайн в работе — оба в «Исполнении»', () => {
    expect(whereSingle(units({ queue: [queueRow()] }))).toBe('execute')
    const worker = { id: 'w1', lane: null, account: 'a', taskId: 't9', taskTitle: 'Идёт', project: 'sma', machine: 'm1' } as WorkerRow
    expect(whereSingle(units({ workers: [worker] }))).toBe('execute')
  })

  it('закрытая задача — в «Готово», и сорванная тоже: столбик называет их закрытыми, а не удачными', () => {
    const done = (over: Partial<DoneRow>): DoneRow =>
      ({
        id: 'd1',
        title: 'Закрыта',
        project: 'sma',
        machine: 'm1',
        finishedAt: null,
        finishedDuration: null,
        workerId: null,
        attempts: 1,
        ...over,
      }) as DoneRow

    expect(whereSingle(units({ done: [done({})] }))).toBe('done')
    const failed = units({ done: [done({ failed: { reasonLabel: 'Не получилось' } } as Partial<DoneRow>)] })
    expect(whereSingle(failed)).toBe('done')
    expect(failed[0].state).toBe('fail')
  })

  it('сборка, вставшая на сломавшемся куске, — в «ЖДУТ ВАС»; идущая — в «Исполнении»', () => {
    const batch = (over: Partial<BatchRow>): BatchRow =>
      ({
        id: 'b1',
        title: 'Сборка',
        project: 'sma',
        machine: 'm1',
        state: 'running',
        items: [{ id: 'i1', title: 'Кусок', status: 'queued', state: 'running' }],
        holding: null,
        ...over,
      }) as BatchRow

    expect(whereSingle(units({ batches: [batch({})] }))).toBe('execute')
    const stuck = units({
      batches: [
        batch({
          state: 'awaiting_decision',
          items: [{ id: 'i1', title: 'Кусок', status: 'queued', state: 'failed' }],
          question: { itemId: 'i1', itemTitle: 'Кусок', text: '?', options: [{ id: 'skip', label: 'Пропустить' }] },
        }),
      ],
    })
    expect(whereSingle(stuck)).toBe('you')
    // Решение НЕ принимается в столбике: карточка называет, что предстоит, и открывается.
    expect(stuck[0].wait?.cta).toContain('Открыть')
  })
})

describe('доска и счётчики шапки — одна раскладка, а не две', () => {
  const many = () =>
    units({
      phases: [
        phaseRow({ discuss: 'in-progress' }, 0, 'p1'),
        phaseRow({ discuss: 'done', plan: 'done', execute: 'done', verify: 'in-progress' }, 0, 'p2'),
        phaseRow({ discuss: 'done' }, 1, 'p3'),
      ],
      queue: [queueRow({ id: 'q1' })],
      awaiting: [queueRow({ id: 'a1', status: 'awaiting_approval' })],
      done: [
        {
          id: 'd1',
          title: 'Закрыта',
          project: 'sma',
          machine: 'm1',
          finishedAt: null,
          finishedDuration: null,
          workerId: null,
          attempts: 1,
        } as DoneRow,
      ],
    })

  it('шесть столбиков в объявленном порядке, и пустой остаётся столбиком', () => {
    // Пустое «Планирование», убранное с экрана, двигало бы соседей при каждом опросе: место,
    // которое переезжает, человеку приходится искать заново.
    const board = buildBoard([])
    expect(board.map((c) => c.key)).toEqual(BOARD_COLUMNS)
    expect(board.every((c) => c.units.length === 0)).toBe(true)
  })

  it('счётчик каждого столбика равен тому, что в столбике лежит', () => {
    const us = many()
    const board = buildBoard(us)
    const counts = countColumns(us)
    for (const col of board) expect(counts[col.key]).toBe(col.units.length)
  })

  it('ни одна единица не потеряна и ни одна не посчитана дважды', () => {
    const us = many()
    const placed = buildBoard(us).flatMap((c) => c.units)
    expect(placed).toHaveLength(us.length)
    expect(new Set(placed.map((u) => `${u.kind}:${u.id}`)).size).toBe(new Set(us.map((u) => `${u.kind}:${u.id}`)).size)
  })

  it('слова ожидания стоят ТОЛЬКО у того, что лежит в «ЖДУТ ВАС»', () => {
    // Янтарную карточку нельзя нарисовать там, где никто никого не ждёт: слова ожидания
    // принадлежат состоянию `dec` и приходят вместе с ним или не приходят вовсе.
    for (const u of many()) {
      if (columnOf(u) === 'you') expect(u.wait).toBeDefined()
      else expect(u.wait).toBeUndefined()
    }
  })
})
