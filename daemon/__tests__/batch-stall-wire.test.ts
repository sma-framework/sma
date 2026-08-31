/**
 * СБОРКА, ЖДУЩАЯ ЧЕЛОВЕКА, ГОВОРИТ ОБ ЭТОМ ВЕЗДЕ, А НЕ ТОЛЬКО НА СВОЕЙ КАРТОЧКЕ.
 *
 * ═══════════════════════ ЧТО ЗДЕСЬ БЫЛО НЕ ТАК ═══════════════════════════════════════════
 * Измеренный случай: батч из шести карточек встал на сорвавшемся элементе и ждал решения
 * человека («пропустить / повторить / отменить») пятнадцать часов двенадцать минут. Два
 * последних элемента всё это время значились «не начаты — ждут своей очереди в сборке».
 *
 * Строка ожидания была видна РОВНО ОДНОМУ наблюдателю — тому, кто открыл именно эту карточку.
 * В счётчиках доски она не считалась (`awaitingApproval` показывал ноль: там своя сущность,
 * приёмка готовой работы), в очередь не попадала, наружу — ни в телеграм, ни в ленту дня — не
 * кричала. Система вежливо ждала человека, никому об этом не сказав.
 *
 * ПОЧЕМУ ЭТО КЛАСС, А НЕ МЕЛОЧЬ. Правило «маршрут без работника молчит» уже стоило дня, и
 * «отказ называется словами на карточке» — тоже. Здесь та же болезнь с другой стороны: ЖДУЩЕЕ
 * состояние ничем не отличалось от РАБОТАЮЩЕГО ни для одного наблюдателя, кроме одного.
 *
 * ═══════════════════════ ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ ═══════════════════════════════════════
 * Четыре обещания, и каждое — на настоящей очереди, настоящем тике и настоящей отправке через
 * подставной транспорт (тот же приём, которым снимается мост телеграма):
 *
 *   1. ненулевой СЧЁТЧИК доски рядом с приёмкой — и приёмка при этом честно нулевая;
 *   2. ОДНО исходящее сообщение, и в нём названы сборка, элемент и требуемый выбор;
 *   3. простой виден ЧИСЛОМ — на карточке сборки, отдельной отметкой от «когда попросили»;
 *   4. порог — МИНУТЫ: свежий срыв молчит, простоявший говорит один раз.
 *
 * ЧЕГО НЕ ДОКАЗЫВАЕТ. Ни клиента Bot API (`telegram-link`), ни правило выдачи кусков
 * (`loop`), ни двери ответа на вопрос сборки (`front-auth`). Здесь — ровно провод от «сборка
 * встала» до всех трёх мест, где человек мог бы это увидеть.
 */

import { describe, it, expect } from 'vitest'

import { tick, BATCH_STALL_MS } from '../src/loop.mjs'
import { createSummons, summonWords } from '../src/summon.mjs'
import { createMemoryQueue, BATCH_PARENT, brokenItemOf } from '../src/queue/adapter.mjs'
import { deriveState } from '../src/front/state.mjs'

const BOT_TOKEN = '7654321:AAH-fake-secret-value-for-tests-only'
const OWNER_CHAT = 424242
const MINUTE = 60_000
const HOUR = 3_600_000

const okAnswer = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) })

/** Записывает КАЖДЫЙ вызов Bot API: и метод, и тело — на теле держится запрет на кнопки. */
function transport() {
  const calls: Array<{ method: string; payload: any }> = []
  const fetchImpl = async (url: string, init: any) => {
    calls.push({
      method: String(url).split('/').pop() as string,
      payload: init && init.body ? JSON.parse(String(init.body)) : {},
    })
    return okAnswer({ message_id: calls.length })
  }
  return { fetchImpl, calls, sent: () => calls.filter((c) => c.method === 'sendMessage') }
}

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

/**
 * МИР ЖИВОГО СЛУЧАЯ: одна постановка владельца, шесть кусков, один из них сорвался.
 *
 * Состояние создаётся ровно так, как его создаёт работа: кусок БЕРУТ у очереди и роняют её же
 * дверью отказа. Подделать «сорвавшуюся строку» полем в фикстуре значило бы проверить фикстуру.
 *
 * СРЫВ НА ПЕРВОМ КУСКЕ — И ЭТО ЧАСТЬ ВОСПРОИЗВЕДЕНИЯ, а не удобство: тогда на приёмке не стоит
 * ни одной строки, и `awaitingApproval` показывает тот самый честный ноль, при котором пять
 * оставшихся карточек не двигаются с места.
 */
async function stalledWorld({ telegram = true, pieces = 6, breakAt = 1 } = {}) {
  const c = mkClock()
  const queue = createMemoryQueue({ clock: c.clock, expireMs: 300_000 })

  for (let n = 1; n <= pieces; n += 1) {
    await queue.enqueue({
      id: `B-1-${n}`,
      source: 'roster',
      title: `карточка ${n}`,
      lane: 'prod',
      batchId: 'B-1',
    })
    c.advance(10)
  }
  // Постановка пишется ПОСЛЕДНЕЙ — тем же порядком, каким её пишет дверь батча.
  await queue.enqueue({
    id: 'B-1',
    source: 'roster',
    title: 'разгреби мелочь перед демо',
    lane: 'prod',
    batchId: 'B-1',
    data: { batch: BATCH_PARENT, requestedAt: c.clock() },
  })

  // Сборка какое-то время просто РАБОТАЕТ, прежде чем сорваться: без этого отметка просьбы и
  // отметка срыва совпали бы, и «стоит» нельзя было бы отличить от «идёт» даже в прогоне.
  c.advance(4 * MINUTE)

  // Куски до сорвавшегося доводятся до конца, сорвавшийся — роняется.
  for (let n = 1; n <= breakAt; n += 1) {
    const claimed: any = await queue.claimNext('w1', {})
    expect(claimed && claimed.id).toBe(`B-1-${n}`)
    if (n < breakAt) {
      await queue.complete(claimed.id, { receiptRef: `reverify:${n}`, attemptToken: claimed.attemptToken })
    } else {
      await queue.fail(claimed.id, 'tests_red', { attemptToken: claimed.attemptToken })
    }
    c.advance(1000)
  }

  const tg = transport()
  const config: any = {
    pipeline: { enabled: true },
    workers: [],
    agingHours: 24,
    ...(telegram ? { telegram: { botToken: BOT_TOKEN, chatId: OWNER_CHAT, apiBase: 'https://tg.test' } } : {}),
  }
  const journal: any[] = []
  const summon = createSummons({ config, now: c.clock, fetchImpl: tg.fetchImpl })
  const deps: any = { adapter: queue, config, clock: c.clock, journal: (e: any) => journal.push(e), summon }

  const read = () =>
    deriveState({
      adapter: queue,
      windows: () => ({ fiveHour: { status: 'open' }, week: { status: 'open' } }),
      config,
      clock: c.clock,
    })

  return { deps, tg, journal, queue, config, read, advance: c.advance, clock: c.clock }
}

// ═══════════ 1 · СЧЁТЧИК ДОСКИ: ЖДУЩАЯ СБОРКА — ЭТО ЧИСЛО, А НЕ СОСТОЯНИЕ ЭЛЕМЕНТА ═════════

describe('доска называет сборку, которая ждёт решения человека', () => {
  it('счётчик ненулевой — и это НЕ приёмка: та честно показывает ноль', async () => {
    const w = await stalledWorld()
    const payload: any = await w.read()

    // Ровно тот ноль, из-за которого полсуток простоя выглядели спокойным днём.
    expect(payload.kpis.awaitingApproval).toBe(0)
    expect(payload.kpis.batchesAwaitingDecision).toBe(1)
  })

  it('счётчик считает СБОРКИ, а не их куски: две вставшие сборки — это два', async () => {
    const w = await stalledWorld()
    // Вторая постановка, того же вида и тоже со сорвавшимся куском.
    await w.queue.enqueue({ id: 'B-2-1', source: 'roster', title: 'вторая карточка', lane: 'prod', batchId: 'B-2' })
    await w.queue.enqueue({
      id: 'B-2',
      source: 'roster',
      title: 'вторая постановка',
      lane: 'prod',
      batchId: 'B-2',
      data: { batch: BATCH_PARENT },
    })
    // Куски первой сборки очередь больше не выдаёт — она стоит; свободен только кусок второй.
    const claimed: any = await w.queue.claimNext('w1', {})
    expect(claimed.id).toBe('B-2-1')
    await w.queue.fail(claimed.id, 'tests_red', { attemptToken: claimed.attemptToken })

    const payload: any = await w.read()
    expect(payload.kpis.batchesAwaitingDecision).toBe(2)
  })

  it('владелец ответил «пропустить» — счётчик снова ноль, и никто его не обнулял руками', async () => {
    const w = await stalledWorld()
    expect(((await w.read()) as any).kpis.batchesAwaitingDecision).toBe(1)

    // Слово владельца записывается ТОЙ ЖЕ дверью очереди, какой его пишет ответ с карточки.
    await w.queue.resolveBatch('B-1', { skip: 'B-1-1' })

    const payload: any = await w.read()
    expect(payload.kpis.batchesAwaitingDecision).toBe(0)
    expect(payload.batches[0].question).toBeUndefined()
  })
})

// ═══════════ 2 · ПРОСТОЙ ВИДЕН ЧИСЛОМ ═════════════════════════════════════════════════════

describe('простой вставшей сборки назван числом, а не выведен из вида карточки', () => {
  it('карточка несёт «с какого момента» и «сколько уже», и это НЕ отметка просьбы', async () => {
    const w = await stalledWorld()
    w.advance(15 * HOUR + 12 * MINUTE) // ровно тот случай, ради которого всё это

    const payload: any = await w.read()
    const batch = payload.batches.find((b: any) => b.id === 'B-1')

    expect(batch.state).toBe('failed')
    expect(batch.question.itemId).toBe('B-1-1')
    // Момент простоя — это момент СРЫВА, а не момент просьбы: между ними лежит работа, которую
    // сборка успела сделать, и сложить их значило бы назвать простоем всю жизнь сборки.
    expect(batch.stalledSince).toBeLessThan(w.clock())
    expect(batch.stalledSince).not.toBe(batch.requestedAt)
    expect(Math.round((w.clock() - batch.stalledSince) / MINUTE)).toBe(15 * 60 + 12)
  })

  it('идущая сборка простоя не имеет вовсе: полей нет, а не ноль в них', async () => {
    const w = await stalledWorld({ pieces: 3, breakAt: 1 })
    // Отменённая сборка никого не держит — ни вопроса, ни простоя.
    await w.queue.resolveBatch('B-1', { cancel: true })

    const payload: any = await w.read()
    const batch = payload.batches.find((b: any) => b.id === 'B-1')
    expect(batch.state).toBe('cancelled')
    expect(batch.stalledSince).toBeUndefined()
  })
})

// ═══════════ 3 · НАРУЖУ: ОДНО СООБЩЕНИЕ, И В НЁМ ЕСТЬ ТО, РАДИ ЧЕГО ЕГО ЧИТАЮТ ═════════════

describe('вставшая сборка кричит наружу тем же путём, что и всё срочное', () => {
  it('красный тест целиком: ненулевой счётчик И одно исходящее — вместо тишины', async () => {
    const w = await stalledWorld()
    w.advance(15 * HOUR)
    await tick(w.deps)

    expect(((await w.read()) as any).kpis.batchesAwaitingDecision).toBe(1)
    expect(w.tg.sent()).toHaveLength(1)
    expect(w.journal.filter((e) => e.type === 'summon' && e.kind === 'batch')).toHaveLength(1)
  })

  it('в сообщении названы сборка, элемент, требуемый выбор и срок простоя', async () => {
    const w = await stalledWorld()
    w.advance(15 * HOUR + 12 * MINUTE)
    await tick(w.deps)

    const text = w.tg.sent()[0].payload.text as string
    expect(text).toContain('разгреби мелочь перед демо') // какая сборка
    expect(text).toContain('карточка 1') // на каком элементе
    expect(text).toContain('Нужен ваш выбор') // что от человека хотят
    expect(text).toContain('пропустить элемент, повторить его или отменить сборку')
    expect(text).toContain('Стоит 15 ч 12 мин') // и сколько это уже стоит
  })

  it('кнопок в чате нет — ни в теле запроса, ни в словах', async () => {
    const w = await stalledWorld()
    w.advance(HOUR)
    await tick(w.deps)

    const payload = w.tg.sent()[0].payload
    expect(Object.keys(payload).sort()).toEqual(['chat_id', 'text'])
    expect(payload.reply_markup).toBeUndefined()
    expect(payload.text).toContain('Кнопок в этом чате нет')
  })

  it('порог — МИНУТЫ, а не часы: свежий срыв молчит, простоявший говорит', async () => {
    const w = await stalledWorld()
    await tick(w.deps)
    expect(w.tg.sent()).toHaveLength(0) // сорвалось только что — состояние живёт иногда один тик

    w.advance(BATCH_STALL_MS + 1000)
    await tick(w.deps)
    expect(w.tg.sent()).toHaveLength(1)
    expect(BATCH_STALL_MS).toBeLessThanOrEqual(10 * MINUTE)
  })

  it('одно ожидание — одно сообщение: следующие проходы тика молчат', async () => {
    const w = await stalledWorld()
    w.advance(HOUR)
    await tick(w.deps)
    await tick(w.deps)
    await tick(w.deps)

    expect(w.tg.sent()).toHaveLength(1)
  })

  it('владелец ответил — сборка замолкает совсем, а не «повторится через шесть часов»', async () => {
    const w = await stalledWorld()
    w.advance(HOUR)
    await tick(w.deps)
    expect(w.tg.sent()).toHaveLength(1)

    await w.queue.resolveBatch('B-1', { skip: 'B-1-1' })
    w.advance(7 * HOUR)
    await tick(w.deps)

    expect(w.tg.sent()).toHaveLength(1)
  })

  /**
   * ГРАНИЦА, БЕЗ КОТОРОЙ КАНАЛ СТАНОВИТСЯ ШУМОМ — та же, что у соседних поводов: зовут только
   * туда, где без человека не двинется. Отменённая сборка не ждёт никого: её незапущенные
   * куски вынуты из очереди словом самого владельца.
   */
  it('отменённая владельцем сборка человека НЕ зовёт', async () => {
    const w = await stalledWorld()
    await w.queue.resolveBatch('B-1', { cancel: true })
    w.advance(15 * HOUR)
    await tick(w.deps)

    expect(w.tg.calls).toHaveLength(0)
  })

  it('бот не подключён — ни отправки, ни ошибки, и ожидание не помечено позванным', async () => {
    const w = await stalledWorld({ telegram: false })
    w.advance(HOUR)
    await tick(w.deps)
    expect(w.tg.calls).toHaveLength(0)
    expect(w.journal.filter((e) => e.type === 'summon-error')).toHaveLength(0)

    // Владелец подключает бота из окна — конфиг живой, перезапуска демона не было.
    w.config.telegram = { botToken: BOT_TOKEN, chatId: OWNER_CHAT, apiBase: 'https://tg.test' }
    await tick(w.deps)
    expect(w.tg.sent()).toHaveLength(1)
  })
})

// ═══════════ 4 · ОДНО ПРАВИЛО НА ВСЕХ: КТО ИМЕННО ДЕРЖИТ СБОРКУ ════════════════════════════

describe('«какой кусок держит сборку» — одно правило, а не три похожих', () => {
  it('карточка и зов говорят об ОДНОМ элементе — обе стороны спрашивают очередь', async () => {
    const w = await stalledWorld()
    w.advance(HOUR)
    await tick(w.deps)

    const payload: any = await w.read()
    const asked = payload.batches.find((b: any) => b.id === 'B-1').question.itemId
    expect(w.tg.sent()[0].payload.text).toContain('карточка 1')
    expect(asked).toBe('B-1-1')
  })

  it('пропущенный кусок сборку больше не держит — правило знает про слово владельца', () => {
    const rows = [
      { id: 'p1', status: 'failed', title: 'раз' },
      { id: 'p2', status: 'failed', title: 'два' },
    ]
    expect(brokenItemOf(rows)!.id).toBe('p1')
    expect(brokenItemOf(rows, ['p1'])!.id).toBe('p2')
    expect(brokenItemOf(rows, ['p1', 'p2'])).toBeNull()
    expect(brokenItemOf([])).toBeNull()
  })

  it('слова зова чистые: те же входы — тот же текст, без сети и без часов', () => {
    const text = summonWords({
      kind: 'batch',
      taskId: 'B-9',
      title: 'разгреби мелочь',
      itemId: 'B-9-2',
      itemTitle: 'починить дверь',
      since: 0,
      now: 15 * HOUR,
    })
    expect(text).toContain('Сборка «разгреби мелочь» стоит на элементе «починить дверь»')
    expect(text).toContain('Стоит 15 ч')
    // Сборка без имени зовёт по своему ярлыку, а не пустотой — как и работа.
    expect(summonWords({ kind: 'batch', taskId: 'B-9', itemId: 'B-9-2', since: 0, now: 0 })).toContain('«B-9»')
  })
})
