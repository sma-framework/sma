/**
 * ГОТОВНОСТЬ ФАЗЫ: ТРИ ИСТОЧНИКА, ОДНА КАРТОЧКА — И СЛОВО, КОТОРОЕ ОБЯЗАНО ЗНАЧИТЬ ОДНО.
 *
 * О готовности фазы в этом доме говорят ТРИ разных места, и говорят они о разном:
 *   1. РОАДМАП — галочка человека: «эту фазу я закрыл». Слово владельца о работе целиком.
 *   2. ДИСК — документы в папке фазы: ступень «пройдена» ровно тогда, когда её артефакт лежит
 *      на диске. Замер, а не мнение.
 *   3. ОЧЕРЕДЬ — запущена ли ПРЯМО СЕЙЧАС какая-нибудь стадия. Признак движения, и только он.
 *
 * Экран задач показывает одну карточку на фазу, и до этой работы она мешала все три в одно
 * слово, отчего спорила сама с собой двумя способами:
 *
 *   — «ИДЁТ» ОЗНАЧАЛО «НАЧАТА И НЕ ЗАКОНЧЕНА», а не «что-то движется». Фаза, у которой три
 *     стадии пройдены, а четвёртая не запущена, носила синее «Идёт» и в том же кадре, строкой
 *     ниже, писала «Ни одна стадия сейчас не запущена». Точка при этом не пульсировала — потому
 *     что признак движения у строки СВОЙ и он честный. Человек читал два разных ответа на один
 *     вопрос и шёл искать, какой из них сломан.
 *
 *   — ЗАКРЫТИЕ В РОАДМАПЕ ДО КАРТОЧКИ НЕ ДОЕЗЖАЛО ВОВСЕ. Фаза, которую человек закрыл галочкой,
 *     но чьи стадии на диске не записаны (закрыта до появления ступеней, закрыта чужим
 *     инструментом, закрыта одним разговором), показывалась незавершённой — навсегда, потому
 *     что документа, которого никто не напишет, диск не дождётся никогда. Командная строка при
 *     этом читала галочку и считала фазу закрытой: два ответа, и ни один не назван.
 *
 * ЧТО ЗАКРЕПЛЕНО ЗДЕСЬ. «Идёт» — только при запущенной стадии; начатая, но никуда не идущая
 * фаза — «На паузе». Закрытая роадмапом фаза не показывается незавершённой, и расхождение с
 * диском НАЗВАНО СЛОВАМИ на самой карточке — потому что молча предпочесть один источник
 * другому значит спрятать спор, а не разрешить его. Инлайн-задача и сборка воронкой стадий не
 * меряются вовсе: у них нет ни стадий, ни роадмапа, и ни одно слово фазы к ним не прилипает.
 *
 * Единицы строятся НАСТОЯЩИМ `buildUnits` из голых рядов двери — подделанная единица отвечала
 * бы из того самого допущения, которое проверяется.
 */

import { describe, it, expect } from 'vitest'

import { buildBoard, buildUnits, columnOf, STATE_WORD } from '../../spa/src/screens/tasks/units'
import type { BoardColumn, WorkUnit } from '../../spa/src/screens/tasks/units'
import type {
  BatchRow,
  DoneRow,
  PhaseIndexRow,
  PhaseStage,
  PhaseStageStatus,
  QueueRow,
  WorkerRow,
} from '../../spa/src/api/types'

/** Дорога фазы — тем же составом и порядком, каким её несёт экран. */
const STAGES: PhaseStage[] = ['discuss', 'plan', 'design', 'execute', 'verify']

function phaseRow(
  stages: Partial<Record<PhaseStage, PhaseStageStatus>>,
  over: Partial<PhaseIndexRow> = {},
): PhaseIndexRow {
  return {
    id: 'p1',
    name: '4 · Окно списка',
    stages: { discuss: 'none', plan: 'none', design: 'none', execute: 'none', verify: 'none', ...stages },
    open: 0,
    answered: 0,
    ...over,
  }
}

function units(input: {
  queue?: QueueRow[]
  awaiting?: QueueRow[]
  workers?: WorkerRow[]
  done?: DoneRow[]
  batches?: BatchRow[]
  phases?: PhaseIndexRow[]
}): WorkUnit[] {
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

/** Единственная единица списка — читается через ту же сборку, что и экран. */
function only(us: WorkUnit[]): WorkUnit {
  expect(us).toHaveLength(1)
  return us[0]
}

/** Всё, что карточка ГОВОРИТ человеку: слово состояния, состав и предложение. */
function said(unit: WorkUnit): string {
  return `${STATE_WORD[unit.state]} · ${unit.inner} · ${unit.next}`
}

describe('«Идёт» — это движение, а не начатость', () => {
  it('запущенная стадия — «Идёт», и точка живая', () => {
    const unit = only(units({ phases: [phaseRow({ discuss: 'done', plan: 'in-progress' })] }))
    expect(STATE_WORD[unit.state]).toBe('Идёт')
    expect(unit.live).toBe(true)
    expect(unit.next).toContain('Стадия идёт')
  })

  it('начатая фаза, у которой сейчас не запущено ничего, — «На паузе», а не «Идёт»', () => {
    // Ровно тот кадр, на котором карточка спорила сама с собой: три стадии позади, ни одна не
    // запущена, точка не пульсирует — и синее «Идёт» над предложением «ни одна не запущена».
    const unit = only(
      units({ phases: [phaseRow({ discuss: 'done', plan: 'done', design: 'done' })] }),
    )
    expect(STATE_WORD[unit.state]).toBe('На паузе')
    expect(unit.live).toBe(false)
    expect(unit.next).toContain('Ни одна стадия сейчас не запущена')
    // И это — весь смысл теста: слово и предложение больше не отвечают на один вопрос по-разному.
    expect(said(unit)).not.toContain('Идёт')
  })

  it('фаза, не начинавшаяся вовсе, остаётся «Не начата» — пауза ей не приписывается', () => {
    const unit = only(units({ phases: [phaseRow({})] }))
    expect(STATE_WORD[unit.state]).toBe('Не начата')
    expect(unit.live).toBe(false)
  })

  it('ни одна карточка фазы не носит слова движения при мёртвой точке', () => {
    // Замок на весь класс, а не на один кадр: «Идёт» и `live` — два написания одного факта, и
    // разойтись они не имеют права ни на одном сочетании стадий.
    for (const stage of STAGES) {
      const before = STAGES.slice(0, STAGES.indexOf(stage))
      const running = only(
        units({
          phases: [
            phaseRow(
              Object.fromEntries([
                ...before.map((s) => [s, 'done' as PhaseStageStatus]),
                [stage, 'in-progress' as PhaseStageStatus],
              ]),
            ),
          ],
        }),
      )
      expect(STATE_WORD[running.state] === 'Идёт').toBe(running.live)

      const parked = only(
        units({ phases: [phaseRow(Object.fromEntries(before.map((s) => [s, 'done' as PhaseStageStatus])))] }),
      )
      expect(STATE_WORD[parked.state] === 'Идёт').toBe(parked.live)
    }
  })
})

describe('фаза, закрытая роадмапом, незавершённой не показывается', () => {
  /** Закрыта галочкой человека; на диске — только разговор, стадий никто не записывал. */
  const closedInRoadmap = (stages: Partial<Record<PhaseStage, PhaseStageStatus>> = {}) =>
    only(units({ phases: [phaseRow(stages, { roadmapClosed: true })] }))

  it('роадмап закрыл, диск не записал — карточка не зовёт фазу ни идущей, ни неначатой', () => {
    const unit = closedInRoadmap()
    expect(STATE_WORD[unit.state]).toBe('Готово')
    expect(said(unit)).not.toContain('Не начата')
    expect(said(unit)).not.toContain('Идёт')
  })

  it('и РАСХОЖДЕНИЕ НАЗВАНО СЛОВАМИ: сказано, что закрыл роадмап и чего не подтверждает диск', () => {
    // Молча предпочесть один источник другому значит спрятать спор. Карточка обязана назвать
    // оба: слово о закрытии — из роадмапа, числа — с диска.
    const unit = closedInRoadmap({ discuss: 'done' })
    expect(unit.inner).toContain('роадмап')
    expect(unit.next.toLowerCase()).toContain('роадмап')
    expect(unit.next).toContain('диск')
    expect(unit.next).toMatch(/1 из 5/)
  })

  it('стоит она в «Готово», а не в столбике недойденной стадии', () => {
    // Слово карточки и её место обязаны совпадать: «Готово» в столбике «Проверка» — это тот же
    // спор, только переехавший из строки в раскладку.
    const unit = closedInRoadmap({ discuss: 'done', plan: 'done' })
    expect(columnOf(unit)).toBe<BoardColumn>('done')
    const board = buildBoard([unit]).find((c) => c.units.length === 1)
    expect(board?.key).toBe('done')
  })

  it('когда диск согласен с роадмапом, о расхождении не говорится ни слова', () => {
    const agreed = only(
      units({
        phases: [
          phaseRow(
            Object.fromEntries(STAGES.map((s) => [s, 'done' as PhaseStageStatus])),
            { roadmapClosed: true },
          ),
        ],
      }),
    )
    expect(STATE_WORD[agreed.state]).toBe('Готово')
    expect(said(agreed).toLowerCase()).not.toContain('роадмап')
    expect(said(agreed)).not.toContain('диск')
  })

  it('без галочки роадмапа та же фаза читается ровно как раньше — правило не трогает соседей', () => {
    const untouched = only(units({ phases: [phaseRow({ discuss: 'done' })] }))
    expect(STATE_WORD[untouched.state]).toBe('На паузе')
    expect(said(untouched).toLowerCase()).not.toContain('роадмап')
  })

  it('галочка не закрывает ВОПРОС: фаза с открытым вопросом всё равно ждёт человека', () => {
    // Роадмап говорит о работе, а вопрос задан человеку и никем не отвечен. Закрыть чужой
    // вопрос галочкой в другом файле — это потерять его, а не решить.
    const asking = only(units({ phases: [phaseRow({ discuss: 'done' }, { roadmapClosed: true, open: 2 })] }))
    expect(STATE_WORD[asking.state]).toBe('Ждёт решения')
    expect(columnOf(asking)).toBe<BoardColumn>('you')
    expect(asking.wait?.what).toContain('к вам')
  })

  it('демон, не знающий этого поля вовсе, читается как «галочки нет», а не как закрытая фаза', () => {
    // Процесс, поднятый до появления поля, отвечает без него. Молчание — это «не отмечена»:
    // объявить закрытым то, о чём никто ничего не сказал, — это выдумка, а не чтение.
    const silent = only(units({ phases: [phaseRow({ discuss: 'done', plan: 'done' })] }))
    expect(STATE_WORD[silent.state]).not.toBe('Готово')
  })
})

describe('инлайн и сборка воронкой стадий не меряются', () => {
  const queueRow = (over: Partial<QueueRow> = {}): QueueRow =>
    ({
      id: 't1',
      title: 'Задача',
      lane: null,
      project: 'sma',
      machine: 'm1',
      priority: 0,
      status: 'queued',
      position: 1,
      ...over,
    }) as QueueRow

  const doneRow = (over: Partial<DoneRow> = {}): DoneRow =>
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

  const worker = {
    id: 'w1',
    lane: null,
    account: 'a',
    taskId: 't9',
    taskTitle: 'В работе',
    project: 'sma',
    machine: 'm1',
  } as WorkerRow

  const batch = {
    id: 'b1',
    title: 'Сборка',
    project: 'sma',
    machine: 'm1',
    state: 'running',
    items: [{ id: 'i1', title: 'Кусок', status: 'queued', state: 'running' }],
    holding: null,
  } as BatchRow

  const everything = () =>
    units({ queue: [queueRow()], workers: [worker], done: [doneRow()], batches: [batch] })

  it('ни в составе, ни в предложении у них нет ни стадий, ни роадмапа', () => {
    const us = everything()
    expect(us.length).toBeGreaterThan(3)
    for (const unit of us) {
      expect(unit.kind, unit.id).not.toBe('phase')
      expect(said(unit).toLowerCase(), unit.id).not.toContain('стади')
      expect(said(unit).toLowerCase(), unit.id).not.toContain('роадмап')
    }
  })

  it('слово «На паузе» принадлежит фазе — ни одна инлайн-строка и ни одна сборка его не носит', () => {
    for (const unit of everything()) expect(STATE_WORD[unit.state], unit.id).not.toBe('На паузе')
  })

  it('поля фазы, доехавшие на чужой строке, проекция не читает', () => {
    // Строка очереди, которой кто-то приписал закрытие роадмапом и пройденные стадии, остаётся
    // ждущей работника: у инлайна дорога одна, и мерить его воронкой фаз нечем.
    const smuggled = only(
      units({
        queue: [
          queueRow({
            ...({ roadmapClosed: true, stages: { discuss: 'done' }, open: 3 } as Partial<QueueRow>),
          }),
        ],
      }),
    )
    expect(smuggled.kind).toBe('inline')
    expect(STATE_WORD[smuggled.state]).toBe('Не начата')
    expect(smuggled.segs).toEqual([])
    expect(said(smuggled).toLowerCase()).not.toContain('роадмап')
  })
})
