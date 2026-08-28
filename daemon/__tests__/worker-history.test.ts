/**
 * ЧТО РАБОТНИК ДЕЛАЛ — ПРОВОД ДО ГЛАЗ И ИСТОРИЯ РАБОТ.
 *
 * ═══════════════ ЗАЧЕМ ЭТОТ ФАЙЛ ═══════════════
 *
 * Здесь сторожатся два разных дефекта, и первый из них — не про арифметику вовсе.
 *
 * ПЕРВЫЙ: «посчитано и не подключено». Числа за 30 дней считались демоном из леджера попыток,
 * доезжали до строки работника в состоянии — и на этом их путь заканчивался: до глаз человека
 * их доводила разметка, о которой не было ни одного утверждения. Такая работа выглядит
 * несделанной, потому что провод рвётся в единственном месте, где никто не смотрит. Поэтому
 * ниже стоит ТЕСТ ПРОВОДА: он не проверяет подсчёт (тот сторожится в worker-stats.test.ts),
 * он проверяет, что число, приехавшее в состоянии, превращается в ТУ САМУЮ строку, которую
 * печатает карточка, — через ту же функцию, что зовёт карточка.
 *
 * ВТОРОЙ: работника можно было нажать и уйти в его ТЕКУЩУЮ задачу, а «что он делал» экран не
 * знал вовсе. История собирается из того же прохода по леджеру, что и числа, и склеивается со
 * строками очереди — оттуда название, род работы и последнее слово ЧЕЛОВЕКА о ней.
 *
 * ═══════════════ ЧТО ИМЕННО ПИНИТСЯ ═══════════════
 *
 *   · провод чисел: состояние → слова карточки, включая «нет данных» вместо нулей;
 *   · история отдаёт работы с исходом каждой — принята / возвращена / сорвалась;
 *   · инлайн-задачи и фазы различимы и раскладываются РАЗНЫМИ списками (просьба владельца);
 *   · одна работа — одна строка: задача, переделанная дважды, не двоится, и слово при ней —
 *     последнее;
 *   · строки очереди в чтении нет → род не выдумывается, а называется неизвестным, и остаётся
 *     слово самого подхода из леджера;
 *   · нечитаемый леджер → истории НЕТ вовсе (не пустой список): пустой читается как «он ничего
 *     не вёл», а это утверждение;
 *   · и ПОСЛЕДНЕЕ ЗВЕНО — что разметке передали именно эту пару и именно эту историю: звать
 *     правильную функцию, кормя её не тем значением, можно совершенно зелёно.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordAttempt } from '../src/queue/attempt-ledger.mjs'
import { createWorkerStats } from '../src/front/worker-stats.mjs'
import { deriveState } from '../src/front/state.mjs'
// Те самые функции, которые зовёт окно: утверждение о проводе, сделанное над копией правила,
// зелено ровно потому, что копия — не то, что показывают человеку.
import { OUTCOME_WORDS, splitHistory, statsWords } from '../../spa/src/screens/team/history'
import type { WorkerHistoryRow } from '../../spa/src/api/types'

const DAY = 86_400_000
const NOW = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const dirs: string[] = []
function ledgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-worker-history-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** Одно чтение состояния над заданными строками очереди и заданным сборщиком чисел. */
async function readState(rows: object[], workerStats: object | null): Promise<any> {
  return deriveState({
    adapter: { list: async () => rows.slice() },
    ...(workerStats ? { workerStats } : {}),
    windows: () => ({ fiveHour: { status: 'unknown' }, week: { status: 'unknown' } }),
    config: { workers: [{ id: 'w1', lane: 'prod', account: { name: 'a1' } }] },
    clock: () => NOW,
  } as never)
}

describe('ПРОВОД: числа, приехавшие в состоянии, доезжают до слов карточки', () => {
  it('пара из состояния становится строкой, которую печатает карточка', async () => {
    // Числа ПОДСТАВЛЕНЫ, и это намеренно: здесь утверждается провод, а не подсчёт. Считать
    // умеет worker-stats, и его арифметика сторожится своим файлом; если бы этот тест считал
    // сам, он краснел бы от изменений в подсчёте и молчал бы о разорванном проводе.
    const payload = await readState([], { statsFor: () => ({ done: 7, failed: 2 }) })

    expect(payload.workers[0].stats30d).toEqual({ done: 7, failed: 2 })

    const said = statsWords(payload.workers[0].stats30d)
    expect(said.kind).toBe('measured')
    expect(said.text).toBe('сделано: 7 · не получилось: 2')
    // И ровно те числа, что приехали: карточка печатает их по отдельности, крупно.
    expect([said.done, said.failed]).toEqual([7, 2])
  })

  it('леджер не прочитался → карточка говорит «нет данных», а не рисует нули', async () => {
    const payload = await readState([], { statsFor: () => null })
    expect(payload.workers[0].stats30d).toBeUndefined()

    const said = statsWords(payload.workers[0].stats30d ?? null)
    expect(said.kind).toBe('unknown')
    expect(said.text).toBe('нет данных')
  })

  it('измеренный ноль — это ответ, и он говорится словами, а не парой нулей', async () => {
    const payload = await readState([], { statsFor: () => ({ done: 0, failed: 0 }) })
    const said = statsWords(payload.workers[0].stats30d)
    expect(said.kind).toBe('empty')
    expect(said.text).toBe('завершённых попыток не было')
  })
})

describe('ИСТОРИЯ: работы, которые вёл работник, с исходом каждой', () => {
  /** Три работы одного работника, кончившиеся по-разному, и слово человека на строке очереди. */
  function seedThree(dir: string) {
    recordAttempt(dir, { taskId: 'R-1', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - DAY) })
    recordAttempt(dir, { taskId: 'R-2', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - 2 * DAY) })
    recordAttempt(dir, { taskId: 'R-3', attempt: 1, workerId: 'w1', outcome: 'failed', endedAt: iso(NOW - 3 * DAY) })
  }

  const ROWS = [
    { id: 'R-1', status: 'approved', title: 'приёмка окна', lane: 'prod' },
    { id: 'R-2', status: 'returned', title: 'вернули на доработку', lane: 'prod' },
    { id: 'R-3', status: 'failed', title: 'сорвалась на доступе', lane: 'prod' },
  ]

  it('каждая работа названа, и при ней — чем она кончилась', async () => {
    const dir = ledgerDir()
    seedThree(dir)
    const payload = await readState(ROWS, createWorkerStats({ ledgerDir: dir, clock: () => NOW }))
    const history: WorkerHistoryRow[] = payload.workers[0].history

    // Свежие сверху — так их и читают.
    expect(history.map((h) => h.taskId)).toEqual(['R-1', 'R-2', 'R-3'])
    expect(history.map((h) => h.title)).toEqual(['приёмка окна', 'вернули на доработку', 'сорвалась на доступе'])
    expect(history.map((h) => h.outcome)).toEqual(['approved', 'returned', 'failed'])
    // …и это те самые три слова, которые владелец назвал.
    expect(history.map((h) => OUTCOME_WORDS[h.outcome])).toEqual(['принята', 'возвращена', 'сорвалась'])
  })

  it('в карточку любой из них можно уйти: строка несёт идентификатор задачи', async () => {
    const dir = ledgerDir()
    seedThree(dir)
    const payload = await readState(ROWS, createWorkerStats({ ledgerDir: dir, clock: () => NOW }))
    for (const row of payload.workers[0].history) expect(typeof row.taskId).toBe('string')
    expect(payload.workers[0].history.map((h: WorkerHistoryRow) => h.taskId)).toEqual(['R-1', 'R-2', 'R-3'])
  })

  it('«принята» приходит только со строки очереди — из леджера её никто не выводит', async () => {
    const dir = ledgerDir()
    recordAttempt(dir, { taskId: 'R-9', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - DAY) })
    // Строка стоит на «сделано»: подход довёл работу, а человек о ней ещё не сказал ничего.
    const payload = await readState([{ id: 'R-9', status: 'completed', title: 'ждёт слова' }], createWorkerStats({ ledgerDir: dir, clock: () => NOW }))
    expect(payload.workers[0].history[0].outcome).toBe('completed')
    expect(OUTCOME_WORDS[payload.workers[0].history[0].outcome as 'completed']).toBe('сделана')
  })

  it('одна работа — одна строка, и слово при ней последнее', async () => {
    const dir = ledgerDir()
    // Одна задача, два подхода: первый сорвался, второй довёл. В числах это два хода, в
    // истории — одна работа, и она кончилась хорошо.
    recordAttempt(dir, { taskId: 'R-7', attempt: 1, workerId: 'w1', outcome: 'failed', endedAt: iso(NOW - 2 * DAY) })
    recordAttempt(dir, { taskId: 'R-7', attempt: 2, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - DAY) })
    const stats = createWorkerStats({ ledgerDir: dir, clock: () => NOW })
    const payload = await readState([{ id: 'R-7', status: 'approved', title: 'со второго раза' }], stats)

    expect(payload.workers[0].history).toHaveLength(1)
    expect(payload.workers[0].history[0]).toMatchObject({ taskId: 'R-7', outcome: 'approved' })
    // …и числа при этом считают ПОДХОДЫ: список короче не потому, что что-то потеряли.
    expect(payload.workers[0].stats30d).toEqual({ done: 1, failed: 1 })
  })

  it('строки очереди в чтении нет → род не выдумывается, а слово берётся у самого подхода', async () => {
    const dir = ledgerDir()
    recordAttempt(dir, { taskId: 'R-OLD', attempt: 1, workerId: 'w1', outcome: 'failed', endedAt: iso(NOW - DAY) })
    const payload = await readState([], createWorkerStats({ ledgerDir: dir, clock: () => NOW }))

    expect(payload.workers[0].history[0]).toMatchObject({ taskId: 'R-OLD', title: null, kind: null, outcome: 'failed' })
  })

  it('нечитаемый леджер → истории нет вовсе, и это не пустой список', async () => {
    const payload = await readState([], createWorkerStats({ ledgerDir: join(tmpdir(), 'sma-no-such-ledger-9-3'), clock: () => NOW }))
    expect(payload.workers[0].history).toBeUndefined()
  })

  it('демон постарше, без этого умения, просто ничего не несёт', async () => {
    const payload = await readState([], { statsFor: () => ({ done: 1, failed: 0 }) })
    expect(payload.workers[0].history).toBeUndefined()
  })

  it('чужие подходы в историю не попадают', async () => {
    const dir = ledgerDir()
    recordAttempt(dir, { taskId: 'R-MINE', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - DAY) })
    recordAttempt(dir, { taskId: 'R-HIS', attempt: 1, workerId: 'w2', outcome: 'completed', endedAt: iso(NOW - DAY) })
    const payload = await readState([], createWorkerStats({ ledgerDir: dir, clock: () => NOW }))
    expect(payload.workers[0].history.map((h: WorkerHistoryRow) => h.taskId)).toEqual(['R-MINE'])
  })
})

describe('РОД РАБОТЫ: инлайн-задачи и фазы не смешиваются', () => {
  it('фаза узнаётся по конверту стадии на строке, инлайн-задача — по его отсутствию', async () => {
    const dir = ledgerDir()
    recordAttempt(dir, { taskId: 'R-P', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - DAY) })
    recordAttempt(dir, { taskId: 'R-T', attempt: 1, workerId: 'w1', outcome: 'completed', endedAt: iso(NOW - 2 * DAY) })

    const payload = await readState(
      [
        { id: 'R-P', status: 'approved', title: 'план фазы', data: { kind: 'stage', stage: 'plan', phase: '12' } },
        { id: 'R-T', status: 'approved', title: 'обычная правка' },
      ],
      createWorkerStats({ ledgerDir: dir, clock: () => NOW }),
    )

    const byId = new Map<string, WorkerHistoryRow>(payload.workers[0].history.map((h: WorkerHistoryRow) => [h.taskId, h]))
    expect(byId.get('R-P')).toMatchObject({ kind: 'phase', phase: '12' })
    expect(byId.get('R-T')).toMatchObject({ kind: 'task' })
    expect(byId.get('R-T')?.phase).toBeUndefined()
  })

  it('окно раскладывает их РАЗНЫМИ списками, а безродные — своим', () => {
    const rows: WorkerHistoryRow[] = [
      { taskId: 'R-T', title: 'правка', kind: 'task', outcome: 'approved', endedAt: NOW - DAY },
      { taskId: 'R-P', title: 'план фазы', kind: 'phase', phase: '12', outcome: 'approved', endedAt: NOW - 2 * DAY },
      { taskId: 'R-X', title: null, kind: null, outcome: 'failed', endedAt: NOW - 3 * DAY },
    ]
    const groups = splitHistory(rows)

    expect(groups.map((g) => g.key)).toEqual(['phase', 'task', 'unknown'])
    expect(groups.map((g) => g.label)).toEqual(['Фазы', 'Инлайн-задачи', 'Род работы не назван'])
    expect(groups[0].rows.map((r) => r.taskId)).toEqual(['R-P'])
    expect(groups[1].rows.map((r) => r.taskId)).toEqual(['R-T'])
    expect(groups[2].rows.map((r) => r.taskId)).toEqual(['R-X'])
  })

  it('пустых списков не бывает: род, которого нет, не рисуется вовсе', () => {
    const groups = splitHistory([
      { taskId: 'R-T', title: 'правка', kind: 'task', outcome: 'approved', endedAt: NOW },
    ])
    expect(groups.map((g) => g.key)).toEqual(['task'])
  })

  it('внутри списка порядок — свежие сверху, и он держится на своём правиле', () => {
    const groups = splitHistory([
      { taskId: 'СТАРАЯ', title: null, kind: 'task', outcome: 'failed', endedAt: NOW - 10 * DAY },
      { taskId: 'СВЕЖАЯ', title: null, kind: 'task', outcome: 'approved', endedAt: NOW - DAY },
    ])
    expect(groups[0].rows.map((r) => r.taskId)).toEqual(['СВЕЖАЯ', 'СТАРАЯ'])
  })
})

/**
 * ПОСЛЕДНЕЕ ЗВЕНО ПРОВОДА: РАЗМЕТКА, КОТОРОЙ ПЕРЕДАЛИ ИМЕННО ТО ЧИСЛО.
 *
 * Всё, что выше, утверждает провод ДО функции: состояние несёт пару, `statsWords` превращает
 * её в строку, `splitHistory` раскладывает историю. Не утверждённым оставался ровно один стык —
 * тот, на котором эта работа однажды и порвалась: разметка может звать правильную функцию и
 * кормить её НЕ ТЕМ значением (или своим, посчитанным на месте), и всё вышеперечисленное
 * останется зелёным. Пара, приехавшая в состоянии, доезжает до глаз только если её передали.
 *
 * Читается это исходником, а не DOM-ом: у окна нет прогона разметки, зато есть прецедент —
 * `spa-narrow-wire.test.ts` сторожит свои три стыка ровно так же. И у каждого читателя здесь
 * стоит случай на ПОДДЕЛЬНОМ плохом исходнике: проверка, чей поиск не умеет находить, зелена
 * потому, что ничего не искала.
 */
describe('ПРОВОД ДО РАЗМЕТКИ: пара из состояния передана карточке и окну истории', () => {
  const src = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

  /**
   * Значение атрибута открывающего тега — вместе с выражением в фигурных скобках.
   *
   * Границей значения считается пробел ВНЕ скобок: `stats={w.stats30d ?? null}` — одно
   * выражение с пробелами внутри, и наивный разбор по первому пробелу резал бы его по `??`.
   */
  function propOf(source: string, component: string, prop: string): string | null {
    const at = source.indexOf(`<${component}`)
    if (at === -1) return null
    const from = source.indexOf(`${prop}={`, at)
    if (from === -1) return null
    let depth = 0
    let i = from + prop.length + 1
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    return source.slice(from + prop.length + 2, i)
  }

  const TEAM = src('../../spa/src/screens/team/index.tsx')
  const CARD = src('../../spa/src/screens/team/WorkerCard.tsx')
  const WINDOW = src('../../spa/src/screens/team/WorkerHistory.tsx')

  it('карточке передана пара ИЗ СОСТОЯНИЯ, а не собранная экраном', () => {
    expect(propOf(TEAM, 'WorkerCard', 'stats')).toContain('stats30d')
  })

  it('окну истории передана ТА ЖЕ пара — второго мнения о числе взяться неоткуда', () => {
    expect(propOf(TEAM, 'WorkerHistory', 'stats')).toContain('stats30d')
  })

  it('обе разметки печатают её одной функцией, а не своей арифметикой', () => {
    for (const source of [CARD, WINDOW]) {
      expect(source).toContain("from './history'")
      expect(source).toContain('statsWords(stats)')
    }
  })

  it('история в окне берётся у работника из состояния и раскладывается по роду', () => {
    expect(propOf(TEAM, 'WorkerHistory', 'worker')).toBe('opened')
    expect(WINDOW).toContain('splitHistory(worker.history)')
  })

  it('нажатие по работнику открывает историю — обработчик присоединён к карточке', () => {
    expect(propOf(TEAM, 'WorkerCard', 'onOpenHistory')).toContain('setOpenedId(w.id)')
    expect(CARD).toContain('onClick={onOpenHistory}')
  })

  it('читатель умеет НЕ находить: на поддельном исходнике каждая проверка краснеет', () => {
    const bad = '<WorkerCard worker={w} stats={null} onOpenHistory={() => {}} />'
    expect(propOf(bad, 'WorkerCard', 'stats')).toBe('null')
    expect(propOf(bad, 'WorkerCard', 'stats')).not.toContain('stats30d')
    expect(propOf(bad, 'WorkerHistory', 'stats')).toBeNull()
    expect(propOf('<WorkerCard worker={w} />', 'WorkerCard', 'stats')).toBeNull()
  })
})
