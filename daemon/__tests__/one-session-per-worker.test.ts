/**
 * ОДИН РАБОТНИК — ОДНА ЖИВАЯ СЕССИЯ. ПРОВОД НА ТИКЕ, А НЕ ПРАВИЛО НА БУМАГЕ.
 *
 * ═══════════════════════ ЧТО БЫЛО ИЗМЕРЕНО ════════════════════════════════════════════════
 * 02.09.2026, свежий демон: один работник вёл задачу и через шесть минут получил вторую. Обе
 * попытки жили одновременно, в двух копиях, на одной подписке; доска показывала ОДНУ. Днём того
 * же дня то же самое случилось ещё дважды.
 *
 * МЕХАНИЗМ — НЕ ГОНКА, А УСЛОВИЕ. Работников трое, потолок одновременных попыток четыре. Захват
 * спрашивал ТОЛЬКО потолок: пока идущих попыток меньше четырёх, строка бралась — не спрашивая,
 * есть ли кому её вести. Дальше маршрут отвечал «работник занят», и тик ОТСТУПАЛ: перерешал
 * маршрут без фильтра занятости и отдавал работу занятому. При потолке больше числа работников
 * четвёртая строка уезжала занятому ВСЕГДА, а не иногда.
 *
 * ═══════════════════════ ЧТО ЗДЕСЬ ЗАКРЫТО ════════════════════════════════════════════════
 *   1. Свободное место спрашивается ДО захвата: при занятом единственном работнике очередь не
 *      спрашивается вовсе — хотя потолок в этом же деле стоит на четырёх и один пропустил бы.
 *   2. Два прохода внахлёст при одном работнике берут ОДНУ строку, а не две.
 *   3. Гонка, которая всё-таки случилась (пул маршрута у́же общего — кусок сборки закреплён за
 *      одним работником): строка ВОЗВРАЩАЕТСЯ в очередь. Подход не считается, парковки нет,
 *      занятому она не уезжает, а запись о гонке остаётся.
 *   4. …и ВОЗВРАЩЁННАЯ СТРОКА НЕ ДЕРЖИТ ОЧЕРЕДЬ: она откладывается на короткий срок, следующий
 *      проход берёт СЛЕДУЮЩУЮ строку и доводит её до работника, а сама она ждёт своего. Без
 *      этого возврат клал её обратно в голову очереди, и та крутилась на одной строке.
 *   5. «Кто здесь работник» спрашивается ОДНИМ выражением: и счёт мест, и проверка «все заняты»
 *      вычитают верхушку, которая задач не берёт, — иначе второй рубеж не срабатывает никогда.
 *   6. Человек читает это на доске: причина простоя названа словом, а число возвратов — числом.
 *
 * ЧЕГО НЕ ДОКАЗЫВАЕТ: ни фильтра занятости в маршрутизаторе (`worker-role.test.ts`), ни чисел
 * мест на экране (`seats-wire.test.ts`), ни самой двери возврата у обоих хранилищ (общий сьют
 * контракта очереди).
 *
 * Ни базы, ни сети: очередь — памятная, дом идущих попыток — настоящий, маршрут в третьем деле
 * подставной ровно в одном ответе.
 */

import { describe, it, expect } from 'vitest'

import { tick } from '../src/loop.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { createInFlight, concurrencyCap, seatCeiling, workerSeats, seatWorkers } from '../src/queue/in-flight.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { buildUnits } from '../../spa/src/screens/tasks/units'
import type { QueueRow } from '../../spa/src/api/types'

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const work = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'сделать дело',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'зелёные тесты и квитанция',
  ...over,
})

/** ОДИН включённый работник и потолок в ЧЕТЫРЕ: ровно та настройка, на которой мерили. */
const ONE_WORKER = [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }]

function makeDeps(over: any = {}) {
  const journalled: any[] = []
  const spawns: any[] = []
  const c = over.clockObj ?? mkClock()
  const deps: any = {
    adapter: over.adapter,
    ledger: { recordAttempt: (a: any) => a, readAttempts: () => [] },
    config: {
      workers: ONE_WORKER,
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: '/repo',
      pipeline: { enabled: true },
      maxConcurrentAttempts: 4,
      ...over.config,
    },
    routing: { resolveRoute },
    windows: () => true,
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
    verbRunner: async (_bin: string, args: string[]) => {
      const verb = args[1]
      if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
      if (verb === 'worktree') return { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/BL-1', branch: 'wt/BL-1' }) }
      if (verb === 'reverify') return { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:a', diffStat: '+1 -0' }) }
      return { code: 0, stdout: '{}' }
    },
    spawnWorker: (spec: any) => {
      spawns.push(spec)
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    report: async () => {},
    clock: c.clock,
    journal: (e: any) => journalled.push(e),
    ...over.deps,
  }
  return { deps, journalled, spawns, clock: c }
}

describe('свободное место работника — часть условия захвата, а не следствие маршрута', () => {
  it('единственный работник занят — очередь не спрашивается, хотя потолок пропустил бы', async () => {
    const c = mkClock()
    const queue = createMemoryQueue({ clock: c.clock, expireMs: 600000 })
    await queue.enqueue(work())

    let claims = 0
    const counting: any = {
      ...queue,
      claimNext: async (...args: any[]) => {
        claims += 1
        return (queue as any).claimNext(...args)
      },
    }

    // Соседний проход уже ведёт попытку единственным работником — место у него занято.
    const house = createInFlight()
    const seat = house.reserve(4)
    house.name(seat, 'R-раньше', 'max-2')

    const { deps, journalled } = makeDeps({ adapter: counting, clockObj: c, deps: { inFlight: house } })

    // ИМЕННО ЭТО РАЗЛИЧЕНИЕ И ЕСТЬ ПРЕДМЕТ ДЕЛА: потолок здесь ЧЕТЫРЕ и одного места ему мало
    // не бывает — а мест у работников всего одно, и оно занято.
    expect(concurrencyCap(deps.config), 'потолок обязан быть выше числа работников — иначе дело ни о чём').toBe(4)
    expect(seatCeiling(deps.config), 'мест не больше, чем работников').toBe(1)

    const r: any = await tick(deps)

    expect(claims, 'при занятом единственном работнике очередь спрашивать нельзя — выборка И ЕСТЬ захват').toBe(0)
    expect(r.idle, 'проход без свободного работника — простой').toBe(true)
    expect(
      journalled.some((e: any) => e.type === 'tick.concurrency_cap'),
      'отказ обязан быть назван в журнале, иначе снаружи это немая остановка',
    ).toBe(true)

    const [row] = await queue.list({})
    expect(row.status, 'строка осталась в очереди').toBe('queued')
    expect(row.attempt, 'подход не потрачен').toBe(1)
  })

  it('два прохода внахлёст при ОДНОМ работнике берут одну строку, а не две', async () => {
    const c = mkClock()
    const queue = createMemoryQueue({ clock: c.clock, expireMs: 600000 })
    await queue.enqueue(work({ id: 'BL-1' }))
    await queue.enqueue(work({ id: 'BL-2' }))

    const house = createInFlight()
    const { deps } = makeDeps({ adapter: queue, clockObj: c, deps: { inFlight: house } })

    await Promise.all([tick(deps), tick(deps)])

    const rows = await queue.list({})
    const touched = rows.filter((r: any) => r.status !== 'queued')
    expect(touched.length, 'работник один — взятая строка обязана быть одна').toBe(1)
    const waiting = rows.find((r: any) => r.status === 'queued')
    expect(waiting, 'вторая строка обязана остаться в очереди').toBeTruthy()
    expect(waiting.attempt, 'и не заплатить подходом за занятость соседа').toBe(1)
    expect(house.size(), 'дом обязан опустеть — иначе конвейер встанет молча').toBe(0)
  })
})

describe('гонка между проверкой и маршрутом — строка возвращается, а не едет занятому', () => {
  it('маршрут ответил «работник занят»: строка снова в очереди, подход не потрачен, работник не получил второй сессии', async () => {
    const c = mkClock()
    const queue = createMemoryQueue({ clock: c.clock, expireMs: 600000 })
    await queue.enqueue(work())

    // Пул маршрута у́же общего — так бывает у куска сборки, закреплённого за одним работником:
    // свободные соседи есть, а НАЗВАННЫЙ занят. Один ответ подставной, всё остальное настоящее.
    //
    // ПРОБА ПОЛОС ИДЁТ ЧЕРЕЗ ТОТ ЖЕ ШОВ и настоящему ответу не мешает: тик спрашивает маршрут
    // дважды — сперва безымянной пробой «какие полосы вообще едут», потом о самой задаче.
    // Подделан ровно второй вопрос; проба отвечает настоящим маршрутизатором.
    const busyRoute = (taskOrProbe: any, routeDeps: any) =>
      taskOrProbe && taskOrProbe.id
        ? {
            workerId: null,
            provider: 'claude',
            model: null,
            effort: null,
            useApiFallback: false,
            reason: 'все места заняты идущей работой',
            reasonCode: 'worker_busy',
          }
        : resolveRoute(taskOrProbe, routeDeps)

    const assigned: any[] = []
    const watching: any = {
      ...queue,
      assignWorker: async (id: string, workerId: string) => {
        assigned.push({ id, workerId })
        return (queue as any).assignWorker(id, workerId)
      },
    }

    const { deps, journalled, spawns } = makeDeps({
      adapter: watching,
      clockObj: c,
      deps: { inFlight: createInFlight(), routing: { resolveRoute: busyRoute } },
    })

    const r: any = await tick(deps)

    expect(r.releasedToQueue, 'возврат обязан быть назван в ответе прохода').toMatchObject({
      taskId: 'BL-1',
      reason: 'worker_busy',
      ok: true,
    })
    // ВЗЯТОЙ ЭТИМ ПРОХОДОМ СТРОКА НЕ СЧИТАЕТСЯ: к концу прохода она снова ждёт работника, а по
    // `claimed` считают, что тик сделал. Оставленная там, она удваивала бы счёт работы — та же
    // задача была бы «взята» и этим проходом, и тем, который её поведёт.
    expect(r.claimed, 'возвращённая строка не числится взятой — иначе счёт работы удвоится').toBeUndefined()
    expect(r.failed, 'возврат — это не срыв: подход сгорел бы вместе со словом о причине').toBeUndefined()

    const [row] = await queue.list({})
    expect(row.status, 'строка обязана вернуться в очередь, а не остаться взятой и не сорваться').toBe('queued')
    expect(row.attempt, 'подход НЕ считается: работа не виновата в занятости работника').toBe(1)
    expect(row.workerId ?? null, 'занятый работник не назван исполнителем этой строки').toBeNull()

    expect(assigned, 'ни один работник не получил второй строки').toEqual([])
    expect(spawns.length, 'второй живой сессии не появилось').toBe(0)
    expect(
      journalled.some((e: any) => e.type === 'task.route_busy_race'),
      'факт гонки остаётся в журнале — по нему её и считают',
    ).toBe(true)
    expect(row.releaseCount, 'возврат сосчитан на строке — иначе о нём не узнает ни доска, ни человек').toBe(1)
  })

  /**
   * ═══════ ЗАКРЕПЛЁННАЯ СТРОКА ПРИ ЗАНЯТОМ РАБОТНИКЕ НЕ ДЕРЖИТ ОЧЕРЕДЬ ═══════
   *
   * ЧТО БЫЛО БЕЗ ОТСРОЧКИ. Возврат кладёт строку туда, откуда её взяли, — в голову очереди
   * (порядок выдачи это приоритет и время постановки, а возврат ни того ни другого не двигает).
   * Пока причина возврата жива — работник, за которым закреплён кусок сборки, ведёт другую
   * работу, а это минуты, — следующий проход брал ТУ ЖЕ строку, получал тот же ответ и возвращал
   * её снова. Очередь крутилась на одной строке: стоящие за ней не брались вовсе, свободный
   * сосед простаивал, и каждый оборот стоил захвата, записи в хранилище и двух кадров живого
   * потока.
   *
   * ПРОВОД, А НЕ ПРАВИЛО НА БУМАГЕ: два прохода подряд через настоящий тик и настоящую очередь.
   * Первый возвращает закреплённую строку, ВТОРОЙ обязан взять следующую и довести её до
   * работника — иначе отсрочка есть, а толку от неё нет.
   */
  it('закреплённый элемент при занятом работнике не мешает взять следующую строку', async () => {
    const c = mkClock()
    const queue = createMemoryQueue({ clock: c.clock, expireMs: 600000 })
    // Закреплённая работа стоит ПЕРВОЙ по приоритету: «взяли следующую» нельзя будет объяснить
    // порядком строк — только тем, что первая отложена возвратом.
    await queue.enqueue(work({ id: 'BL-1', priority: 5 }))
    await queue.enqueue(work({ id: 'BL-2', priority: 0 }))

    // Пул закреплённой строки — один занятый работник; у всех остальных работ пул общий.
    const pinnedBusy = (taskOrProbe: any, routeDeps: any) =>
      taskOrProbe && taskOrProbe.id === 'BL-1'
        ? {
            workerId: null,
            provider: 'claude',
            model: null,
            effort: null,
            useApiFallback: false,
            reason: 'все места заняты идущей работой',
            reasonCode: 'worker_busy',
          }
        : resolveRoute(taskOrProbe, routeDeps)

    // Двое работников: один ведёт чужую попытку (за ним и закреплена BL-1), второй свободен.
    const house = createInFlight()
    const seat = house.reserve(4)
    house.name(seat, 'R-раньше', 'max-2')

    const { deps, spawns } = makeDeps({
      adapter: queue,
      clockObj: c,
      config: {
        workers: [
          { id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true },
          { id: 'max-3', lane: 'prod', provider: 'claude', account: { configDir: '/y' }, enabled: true },
        ],
      },
      deps: {
        inFlight: house,
        routing: { resolveRoute: pinnedBusy },
        // Запуск обязан НАЗВАТЬ задачу: «работник стартовал» без имени работы не отличает
        // BL-2 от BL-1 и доказывало бы не то, ради чего дело написано.
        buildArgs: (task: any) => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: `сделай ${task.id}` }),
      },
    })

    const first: any = await tick(deps)
    expect(first.releasedToQueue, 'первый проход обязан вернуть закреплённую строку').toMatchObject({
      taskId: 'BL-1',
      ok: true,
    })

    const second: any = await tick(deps)

    expect(second.claimed, 'второй проход обязан взять СЛЕДУЮЩУЮ строку, а не ту же самую').toBe('BL-2')
    expect(spawns.length, 'работник запущен ровно один раз — второй живой сессии не появилось').toBe(1)
    expect(
      String(spawns[0].prompt),
      'до работника доехала СЛЕДУЮЩАЯ строка, а не закреплённая, стоящая перед ней',
    ).toContain('BL-2')

    const rows = await queue.list({})
    const pinned = rows.find((r: any) => r.id === 'BL-1')
    expect(pinned.status, 'закреплённая строка по-прежнему ждёт своего работника').toBe('queued')
    expect(pinned.attempt, 'и не платит подходом за занятость этого работника').toBe(1)
    expect(pinned.releaseCount, 'возврат сосчитан ровно один — второй проход её не трогал').toBe(1)
  })
})

/**
 * ═══════ ОДНО СЛОВО «КТО РАБОТНИК» — И У СЧЁТА МЕСТ, И У ПРОВЕРКИ «ВСЕ ЗАНЯТЫ» ═══════
 *
 * Счёт мест вычитал верхушку (оркестратор задач из очереди не берёт ни при каком порядке строк
 * конфига), а проверка занятости в тике считала её обычным работником — и потому ждала, пока
 * попытку возьмёт тот, кто их не берёт вовсе. Рубеж, написанный ради человеческого слова «все
 * работники уже ведут попытку», при заведённой верхушке не срабатывал никогда. Два выражения
 * одного вопроса расходятся молча; здесь их одно.
 */
describe('кто здесь работник — спрашивается одним выражением', () => {
  const WITH_TOP = [
    { id: 'orchestrator', role: 'orchestrator', lane: 'prod', enabled: true },
    { id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true },
    { id: 'max-9', lane: 'prod', provider: 'claude', account: { configDir: '/y' }, enabled: false },
  ]

  it('верхушка и выключенные не работники — и список, и число говорят это одинаково', () => {
    const config: any = { workers: WITH_TOP, maxConcurrentAttempts: 4 }
    expect(seatWorkers(config).map((w: any) => w.id), 'место держат только те, кто берёт задачи').toEqual(['max-2'])
    expect(workerSeats(config), 'число выходит из того же списка, а не из второго выражения').toBe(1)
    expect(seatCeiling(config), 'мест не больше, чем работников, даже когда потолок выше').toBe(1)
  })

  it('единственный настоящий работник занят — тик называет это своим словом и не берёт строку', async () => {
    const c = mkClock()
    const queue = createMemoryQueue({ clock: c.clock, expireMs: 600000 })
    await queue.enqueue(work())

    // Дом мест не раздаётся (шов собран без него) — остаётся именно поимённый рубеж, ради
    // которого эта проверка и написана.
    const house = createInFlight()
    const seat = house.reserve(4)
    house.name(seat, 'R-раньше', 'max-2')
    const busyOnly: any = { workers: () => house.workers() }

    const { deps, journalled } = makeDeps({
      adapter: queue,
      clockObj: c,
      config: { workers: WITH_TOP },
      deps: { inFlight: busyOnly },
    })

    const r: any = await tick(deps)

    expect(r.allWorkersBusy, 'занятость названа числом настоящих работников, а не длиной конфига').toBe(1)
    expect(r.claimed, 'строка не берётся: вести её некому').toBeUndefined()
    expect(
      journalled.some((e: any) => e.type === 'tick.all_workers_busy'),
      'и сказано это вслух — иначе снаружи немая остановка',
    ).toBe(true)
  })
})

/**
 * ═══════ …И ЧЕЛОВЕК ЧИТАЕТ ЭТО НА ДОСКЕ, А НЕ В ЖУРНАЛЕ ДЕМОНА ═══════
 *
 * Возврат не считает подхода и не оставляет отметок захвата, поэтому строка после трёх возвратов
 * выглядит на экране как только что поставленная: «в очереди · место 1» при свободных соседях.
 * Человек читает это как поломку и идёт искать её там, где её нет. Слово и число складывает окно
 * из того, что написала очередь, — здесь проверяется, что оно доходит до предложения.
 */
describe('доска называет строку, ждущую своего работника', () => {
  const row = (over: Partial<QueueRow> = {}): QueueRow =>
    ({
      id: 'r-wait',
      title: 'Задача',
      lane: null,
      project: 'sma',
      machine: 'm1',
      priority: 0,
      status: 'queued',
      position: 1,
      ...over,
    }) as QueueRow

  const sentenceOf = (queue: QueueRow[]) => {
    const units = buildUnits({
      queue,
      awaiting: [],
      workers: [],
      done: [],
      batches: [],
      phases: [],
      activeProject: 'sma',
      machine: '',
      selfMachine: 'm1',
      clock: () => '12:00',
      now: 1_000_000,
    } as any)
    expect(units).toHaveLength(1)
    return units[0].next
  }

  it('названы и причина, и число возвратов — по нему решают, ждать или снимать закрепление', () => {
    const said = sentenceOf([row({ idleReason: 'worker_busy', releaseCount: 3 })])
    expect(said).toContain('своего работника')
    expect(said).toContain('3 возврата')
  })

  it('один возврат склоняется как один, а пять — как пять', () => {
    expect(sentenceOf([row({ idleReason: 'worker_busy', releaseCount: 1 })])).toContain('1 возврат')
    expect(sentenceOf([row({ idleReason: 'worker_busy', releaseCount: 5 })])).toContain('5 возвратов')
  })

  it('причина без числа (строка старее поля) остаётся предложением, а не пустотой', () => {
    expect(sentenceOf([row({ idleReason: 'worker_busy' })])).toContain('Ждёт своего работника')
  })

  it('строка без возвратов о них молчит — и ждёт свободного работника как обычно', () => {
    expect(sentenceOf([row({})])).toContain('Ждёт свободного работника')
  })
})
