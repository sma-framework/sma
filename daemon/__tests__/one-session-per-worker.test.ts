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
import { createInFlight, concurrencyCap, seatCeiling } from '../src/queue/in-flight.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

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

    expect(r.claimed, 'строка была взята — иначе дело проверяет не ту дорогу').toBe('BL-1')
    expect(r.releasedToQueue, 'возврат обязан быть назван в ответе прохода').toMatchObject({
      taskId: 'BL-1',
      reason: 'worker_busy',
      ok: true,
    })
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
  })
})
