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
