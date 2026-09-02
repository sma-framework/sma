/**
 * ПОТОЛОК МЕСТ ВИДЕН СНАРУЖИ — И ЭТО ПРОВОД, А НЕ ВЫЧИСЛЕНИЕ.
 *
 * ПОВОД. Ошибка в настройке потолка одновременных мест прожила целый день ровно потому, что ни
 * числа мест, ни числа занятых не было НИГДЕ: доска показывала занятых работников, но не
 * говорила, сколько мест всего и сколько свободно. Настройку, действие которой не видно, нельзя
 * уличить — по ней даже был сделан ложный вывод «потолок не работает» и поставлена лишняя
 * работа, которую пришлось отменять.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. Не «в ответе есть поле», а ОТКУДА в нём число: «занято» приходит от
 * дома идущих попыток — от того же объекта, у которого тик берёт место перед захватом, — и
 * движется вместе с ним, а не вместе с карточками работников. Карточка говорит про строку
 * очереди в руках; место занимает ПРОХОД ТИКА. Пока эти два счёта совпадают, второй счёт кажется
 * безобидным; расходятся они ровно тогда, когда потолок ведёт себя не так, как думает человек, —
 * то есть в единственный момент, когда числа и нужны.
 *
 * И ВТОРАЯ ПОЛОВИНА ТОГО ЖЕ: отказ в месте обязан пережить замороженный словарь живого потока.
 * Тип, которого в словаре нет, хаб роняет МОЛЧА — сам файл словаря предупреждает об этом рядом
 * со списком, и это уже стоило продукту одного звонка, который никуда не доехал. Поэтому кадр
 * здесь гоняется через настоящий хаб до настоящей записи в поток.
 *
 * Ни демона, ни базы, ни сети: дом идущих попыток — настоящий, очередь — подставная.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { deriveState } from '../src/front/state.mjs'
import { createEventHub, EVENT_TYPES } from '../src/front/events.mjs'
import { createInFlight, concurrencyCap } from '../src/queue/in-flight.mjs'

const NOW = 1_777_000_000_000

/** Очередь, отдающая ровно то, что ей дали. Дверь состояния читает у неё только list(). */
const mkAdapter = (rows: any[]) => ({
  async list() {
    return rows
  },
})

/** Окна: ничего ни про один счёт не известно — этот файл не про окна. */
const windows = () => ({})

const config = (over: any = {}) => ({
  workers: [
    { id: 'max-1', lane: 'prod', account: { name: 'max-1' } },
    { id: 'max-2', lane: 'research', account: { name: 'max-2' } },
  ],
  pipeline: { enabled: true },
  ...over,
})

const door = (over: any = {}) =>
  deriveState({ adapter: mkAdapter(over.rows ?? []), windows, config: config(over.config), clock: () => NOW, ...over.deps })

describe('места одновременной работы — дверь состояния называет оба числа', () => {
  it('«занято» приходит ОТ ДОМА идущих попыток, а не пересчитывается по карточкам работников', async () => {
    // Дом занят двумя местами, а НИ ОДНА карточка работника не держит задачу: пересчёт по
    // работникам дал бы здесь ноль. Именно это расхождение дело и ловит.
    const house = createInFlight()
    const first = house.reserve(4)
    house.reserve(4)
    house.name(first, 'R-1', 'max-1')

    const payload: any = await door({ config: { maxConcurrentAttempts: 4 }, deps: { inFlight: house } })

    expect(payload.kpis.workersBusy, 'ни один работник строки не держит — счёт по карточкам был бы нулём').toBe(0)
    expect(payload.kpis.seatsBusy, '«занято» обязано прийти от того, кто места раздаёт').toBe(2)
    expect(payload.kpis.seatsTotal, 'мест всего — это потолок, прочитанный там же, где его читает тик').toBe(4)
  })

  it('число занятых ДВИЖЕТСЯ вместе с домом — это провод, а не совпадение', async () => {
    const house = createInFlight()
    const a = house.reserve(3)
    const b = house.reserve(3)

    const busy: any = await door({ config: { maxConcurrentAttempts: 3 }, deps: { inFlight: house } })
    expect(busy.kpis.seatsBusy).toBe(2)

    house.release(a)
    const freer: any = await door({ config: { maxConcurrentAttempts: 3 }, deps: { inFlight: house } })
    expect(freer.kpis.seatsBusy, 'освободилось место — дверь обязана сказать это тем же поллом').toBe(1)

    house.release(b)
    const empty: any = await door({ config: { maxConcurrentAttempts: 3 }, deps: { inFlight: house } })
    expect(empty.kpis.seatsBusy, 'пустой дом — ноль занятых, и это измерение, а не молчание').toBe(0)
  })

  it('«мест всего» — ТО ЖЕ ЧТЕНИЕ НАСТРОЙКИ, по которому тик отказывает в месте', async () => {
    // Молчание настройки — безопасный пол в одну попытку, и на экране обязано стоять то же
    // число, иначе подпись объясняет машину, которой нет.
    const silent: any = await door({ deps: { inFlight: createInFlight() } })
    expect(silent.kpis.seatsTotal, 'молчание настройки — один, и это видно человеку').toBe(concurrencyCap({}))
    expect(silent.kpis.seatsTotal).toBe(1)

    const raised: any = await door({ config: { maxConcurrentAttempts: 6 }, deps: { inFlight: createInFlight() } })
    expect(raised.kpis.seatsTotal).toBe(concurrencyCap({ maxConcurrentAttempts: 6 }))

    // …и дом, набитый ровно до объявленного потолка, следующее место НЕ даёт: число на экране и
    // поведение машины — одно и то же число.
    const house = createInFlight()
    const full: any = await door({ config: { maxConcurrentAttempts: 2 }, deps: { inFlight: house } })
    for (let i = 0; i < full.kpis.seatsTotal; i += 1) house.reserve(full.kpis.seatsTotal)
    expect(house.reserve(full.kpis.seatsTotal), 'дом, полный по объявленному числу, обязан отказать').toBe(null)

    const packed: any = await door({ config: { maxConcurrentAttempts: 2 }, deps: { inFlight: house } })
    expect(packed.kpis.seatsBusy, 'и дверь обязана показать этот же полный дом').toBe(packed.kpis.seatsTotal)
  })

  it('дома не передали — «занято» это null, а не ноль', async () => {
    // Ноль читался бы как «все места свободны», то есть как измерение. Отсутствие дома — это
    // «сказать нечем». Потолок при этом называется всё равно: он есть у любого демона.
    const payload: any = await door({ config: { maxConcurrentAttempts: 5 } })
    expect(payload.kpis.seatsBusy, 'нечем сказать — так и говорим, а не рисуем свободный дом').toBe(null)
    expect(payload.kpis.seatsTotal).toBe(5)
  })
})

/**
 * РАСХОЖДЕНИЕ «МЕСТ ЗАНЯТО» СО СПИСКОМ РАБОТНИКОВ — НАЗЫВАЕТСЯ, А НЕ ОСТАВЛЯЕТСЯ ЧЕЛОВЕКУ.
 *
 * ПОВОД. Доска говорила «мест занято 4» рядом со списком, в котором работали двое. Такое
 * человек читает как ошибку экрана — и идёт чинить экран. Авария была не в экране: за двумя
 * лишними местами шли ЖИВЫЕ сессии, не привязанные ни к одной карточке (строку сняли между
 * захватом и запуском, процесс стартовал следом). Одна из них проработала час невидимой и
 * закончилась коммитом в копию задачи, которой уже нет.
 *
 * ЧТО ДОКАЗЫВАЕТСЯ. Число выведено ИЗ ОДНОГО МЕСТА с обоими своими половинами: занятые места
 * берутся у дома, руки — у тех же карточек работников, которые нарисованы на экране. Поэтому
 * счёт и список не могут разойтись молча: разница называется числом.
 */
describe('места, за которыми не стоит ни одна карточка работника', () => {
  const claimed = (id: string, workerId: string) => ({
    id,
    title: id,
    status: 'claimed',
    workerId,
    lane: 'prod',
    claimedAt: new Date(NOW).toISOString(),
  })

  it('попытка, которой нет ни в одних руках, названа числом — а не оставлена как разница двух цифр', async () => {
    const house = createInFlight()
    const shown = house.reserve(4)
    const hidden = house.reserve(4)
    house.name(shown, 'R-1', 'max-1')
    house.name(hidden, 'R-2', 'max-2')

    const payload: any = await door({
      rows: [claimed('R-1', 'max-1')], // на доске видна ОДНА из двух идущих попыток
      config: { maxConcurrentAttempts: 4 },
      deps: { inFlight: house },
    })

    expect(payload.kpis.seatsBusy, 'мест занято — по-прежнему счёт дома').toBe(2)
    expect(payload.kpis.workersBusy, 'а карточка держит строку ровно одна').toBe(1)
    expect(
      payload.kpis.seatsUnlisted,
      'разница обязана быть НАЗВАНА: одна попытка идёт, и её не показывает ни одна карточка',
    ).toBe(1)
  })

  it('всё, что идёт, видно на карточках — ноль, и это измерение', async () => {
    const house = createInFlight()
    const seat = house.reserve(4)
    house.name(seat, 'R-1', 'max-1')

    const payload: any = await door({
      rows: [claimed('R-1', 'max-1')],
      config: { maxConcurrentAttempts: 4 },
      deps: { inFlight: house },
    })

    expect(payload.kpis.seatsUnlisted, 'обычный день — ни одной невидимой попытки').toBe(0)
  })

  it('жетон, взятый до захвата, ещё ничего не называет — и невидимой попыткой не считается', async () => {
    const house = createInFlight()
    house.reserve(4) // место взято перед тем, как спросить очередь; задачи у него пока нет

    const payload: any = await door({ config: { maxConcurrentAttempts: 4 }, deps: { inFlight: house } })

    expect(payload.kpis.seatsBusy, 'место занято — потолок считает его').toBe(1)
    expect(payload.kpis.seatsUnlisted, 'но обвинять в невидимости нечего: попытки ещё нет').toBe(0)
  })

  it('дома не передали — сказать нечего, и это null, а не ноль', async () => {
    const payload: any = await door({ config: { maxConcurrentAttempts: 4 } })
    expect(payload.kpis.seatsUnlisted).toBe(null)
  })

  /**
   * ПОСЛЕДНЕЕ ЗВЕНО: число, посчитанное дверью, ПЕРЕДАНО разметке. Посчитать и не подключить —
   * это работа, которая выглядит сделанной и не видна ни одним глазом; читается исходником, как
   * и у соседних проводов до разметки (у окна нет прогона разметки, зато есть прецедент).
   */
  it('значок мест получает это число ИЗ СОСТОЯНИЯ, а не считает разницу сам', () => {
    const team = readFileSync(fileURLToPath(new URL('../../spa/src/screens/team/index.tsx', import.meta.url)), 'utf8')
    const at = team.indexOf('<SeatsPill')
    expect(at, 'значок мест обязан стоять на экране команды').toBeGreaterThan(-1)
    const tag = team.slice(at, team.indexOf('/>', at))
    expect(tag, 'разница обязана приехать посчитанной — экран второго мнения о ней не заводит').toContain(
      'seatsUnlisted',
    )
  })
})

describe('отказ в месте виден в живом потоке', () => {
  it('тип отказа объявлен в замороженном словаре — иначе хаб роняет кадр МОЛЧА', () => {
    expect(EVENT_TYPES, 'необъявленный тип не падает, он просто не доезжает — и экран ждёт вечно').toContain(
      'seats.full',
    )
  })

  it('кадр отказа доезжает до открытого клиента и несёт оба числа', () => {
    const seen: string[] = []
    const res: any = {
      destroyed: false,
      writableEnded: false,
      writeHead() {},
      write: (t: string) => seen.push(t),
      end() {},
    }
    const hub = createEventHub({ clock: () => NOW, setTimer: () => null, clearTimer: () => {} })
    hub.addClient(res)

    const delivered = hub.emit({ event: 'seats.full', inFlight: 4, cap: 4 })
    hub.close()

    expect(delivered, 'кадр обязан дойти до открытого клиента').toBe(1)
    const wire = seen.join('')
    expect(wire, 'кадр называется своим именем — по нему окно и подписывается').toContain('event: seats.full')
    const data = JSON.parse(wire.split('data: ').pop()!.split('\n')[0])
    expect(data, 'два числа и ничего больше: занято и всего').toMatchObject({
      event: 'seats.full',
      inFlight: 4,
      cap: 4,
    })
    expect(data.taskId, 'кому именно отказали — читается с экрана по опросу, а не с провода').toBeUndefined()
  })
})
