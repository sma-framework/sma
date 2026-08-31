/**
 * ПОВТОРЯЕМОЕ ПОВТОРЯЕТСЯ САМО — И РОВНО СТОЛЬКО РАЗ, СКОЛЬКО ОБЪЯВЛЕНО.
 *
 * ═══════════════════════ ЧТО ЗДЕСЬ БЫЛО НЕ ТАК ═══════════════════════════════════════════
 * Измеренный случай 31.08: три сборки стояли сорвавшимися со вчерашнего дня и держали за
 * собой десять невыданных работ. У всех трёх упавших кусков причина одна — `provider_error`,
 * чья подпись прямо говорит «оборвал провайдер, работник тут ни при чём, попробуйте ещё раз».
 * Система написала «попробуйте ещё раз» и стала ждать человека. Повторили рукой — все три
 * пошли с первой попытки.
 *
 * Таксономия при этом уже знала правду: `AWAITS_A_PERSON` содержит РОВНО ОДНУ причину
 * (потолок ходов), а все прочие концы объявлены повторяемыми. Слово было сказано, а провода
 * за ним не было: у куска сборки перевыдачи нет вовсе, и сборка, вставшая на куске, не
 * выдавала и остальные свои куски.
 *
 * ═══════════════════════ ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ ═══════════════════════════════════════
 * Всё — на настоящей очереди и настоящем тике, без подделанных строк:
 *
 *   1. конец, не входящий в `AWAITS_A_PERSON` и не остановленный рукой, перевыдаётся САМ;
 *   2. у автоповторов есть ПОТОЛОК и РАСТУЩАЯ ПАУЗА — сломанный канал не даёт петлю;
 *   3. повтор виден в журнале СЛОВАМИ «повторено само, попытка N из M»;
 *   4. исчерпав автоповторы, работа уходит к человеку С ПРИЧИНОЙ, а не ложится молча;
 *   5. сборка не считается сорвавшейся, пока у её куска остаются автоповторы;
 *   6. потолок ходов не повторяется НИКОГДА — и это красный тест на запрет автоповтора.
 *
 * ЧЕГО НЕ ДОКАЗЫВАЕТ: ни зова в телеграм (`batch-stall-wire`), ни выдачи работы работнику
 * (`loop`), ни столбиков окна (`tasks-board`). Здесь — ровно правило повтора и его провод.
 */

import { describe, it, expect } from 'vitest'

import { tick } from '../src/loop.mjs'
import {
  createMemoryQueue,
  BATCH_PARENT,
  AUTO_RETRY_LIMIT,
  AUTO_RETRY_BASE_MS,
  awaitsAutoRetry,
  autoRetryDueAt,
  brokenItemOf,
  batchItemsOf,
} from '../src/queue/adapter.mjs'
import { deriveState } from '../src/front/state.mjs'

const MINUTE = 60_000
const HOUR = 3_600_000

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

/**
 * МИР ЖИВОГО СЛУЧАЯ: постановка владельца, три куска, первый оборван провайдером.
 *
 * Состояние делается ровно так, как его делает работа: кусок БЕРУТ у очереди и роняют её же
 * дверью отказа. Подделать «сорвавшуюся строку» полем в фикстуре значило бы проверить фикстуру.
 */
function world({ pieces = 3 } = {}) {
  const c = mkClock()
  const queue = createMemoryQueue({ clock: c.clock, expireMs: 8 * HOUR })
  const journal: any[] = []
  const config: any = { pipeline: { enabled: true }, workers: [], agingHours: 24 }
  const deps: any = { adapter: queue, config, clock: c.clock, journal: (e: any) => journal.push(e) }

  const read = () =>
    deriveState({
      adapter: queue,
      windows: () => ({ fiveHour: { status: 'open' }, week: { status: 'open' } }),
      config,
      clock: c.clock,
    })

  const rows = async () => queue.list({})
  const rowOf = async (id: string) => (await rows()).find((r: any) => r.id === id)

  const setUp = async () => {
    for (let n = 1; n <= pieces; n += 1) {
      await queue.enqueue({ id: `B-1-${n}`, source: 'roster', title: `кусок ${n}`, lane: 'prod', batchId: 'B-1' })
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
  }

  /** Один провал первого куска: его БЕРУТ у очереди и роняют названной причиной. */
  const breakPiece = async (reason = 'provider_error') => {
    const claimed: any = await queue.claimNext('w1', {})
    expect(claimed && claimed.id).toBe('B-1-1')
    await queue.fail(claimed.id, reason, { attemptToken: claimed.attemptToken })
    return claimed
  }

  return { c, queue, deps, journal, config, read, rows, rowOf, setUp, breakPiece, advance: c.advance, clock: c.clock }
}

/** Ждёт паузу автоповтора целиком и даёт очереди один проход. */
async function waitAndTick(w: ReturnType<typeof world>, pause: number) {
  w.advance(pause + 1000)
  await tick(w.deps)
}

const repeats = (journal: any[]) => journal.filter((e) => e.type === 'auto-retry')

// ═══════════ 1 · ПОВТОРЯЕМЫЙ КОНЕЦ ПЕРЕВЫДАЁТСЯ САМ ═══════════════════════════════════════

describe('конец, за которым не стоит человек, перевыдаётся сам', () => {
  it('оборванный провайдером кусок сборки возвращается в очередь без единого нажатия', async () => {
    const w = world()
    await w.setUp()
    await w.breakPiece()

    // Ровно то состояние, в котором три сборки простояли сутки.
    expect((await w.rowOf('B-1-1')).status).toBe('failed')

    await waitAndTick(w, AUTO_RETRY_BASE_MS)

    const again: any = await w.rowOf('B-1-1')
    expect(again.status).toBe('queued')
    expect(again.attempt).toBe(2)
    // …и очередь снова выдаёт этот кусок работнику — сборка поехала дальше сама.
    expect((await w.queue.claimNext('w1', {}))!.id).toBe('B-1-1')
  })

  it('повтор виден в журнале СЛОВАМИ, а не выводится из номера подхода', async () => {
    const w = world()
    await w.setUp()
    await w.breakPiece()
    await waitAndTick(w, AUTO_RETRY_BASE_MS)

    const said = repeats(w.journal)
    expect(said).toHaveLength(1)
    expect(said[0].taskId).toBe('B-1-1')
    expect(said[0].said).toBe(`повторено само, попытка 1 из ${AUTO_RETRY_LIMIT}`)
    expect(said[0].reason).toBe('provider_error')
  })
})

// ═══════════ 2 · ПОТОЛОК И РАСТУЩАЯ ПАУЗА: СЛОМАННЫЙ КАНАЛ НЕ ДАЁТ ПЕТЛЮ ══════════════════

describe('у автоповтора есть потолок и растущая пауза', () => {
  it('до конца паузы не трогают: тик проходит мимо свежего срыва', async () => {
    const w = world()
    await w.setUp()
    await w.breakPiece()

    await tick(w.deps) // тот же миг
    expect((await w.rowOf('B-1-1')).status).toBe('failed')

    w.advance(AUTO_RETRY_BASE_MS / 2)
    await tick(w.deps)
    expect((await w.rowOf('B-1-1')).status).toBe('failed')
    expect(repeats(w.journal)).toHaveLength(0)
  })

  it('пауза РАСТЁТ: второй повтор ждёт дольше первого', async () => {
    const w = world()
    await w.setUp()
    await w.breakPiece()
    await waitAndTick(w, AUTO_RETRY_BASE_MS)
    await w.breakPiece() // второй подход сорвался так же

    // Первой паузы уже мало — канал лежит, и очередь не бьётся в него с той же частотой.
    w.advance(AUTO_RETRY_BASE_MS + 1000)
    await tick(w.deps)
    expect((await w.rowOf('B-1-1')).status).toBe('failed')

    w.advance(AUTO_RETRY_BASE_MS)
    await tick(w.deps)
    expect((await w.rowOf('B-1-1')).status).toBe('queued')
    expect(repeats(w.journal)).toHaveLength(2)
    expect(repeats(w.journal)[1].said).toBe(`повторено само, попытка 2 из ${AUTO_RETRY_LIMIT}`)
  })

  it('потолок держит: исчерпав автоповторы, строка стоит хоть сутки', async () => {
    const w = world()
    await w.setUp()
    for (let n = 0; n <= AUTO_RETRY_LIMIT; n += 1) {
      await w.breakPiece()
      if (n < AUTO_RETRY_LIMIT) await waitAndTick(w, AUTO_RETRY_BASE_MS * 2 ** n)
    }
    expect(repeats(w.journal)).toHaveLength(AUTO_RETRY_LIMIT)

    // Сутки и три прохода спустя — ни одного лишнего повтора.
    for (let i = 0; i < 3; i += 1) {
      w.advance(8 * HOUR)
      await tick(w.deps)
    }
    expect(repeats(w.journal)).toHaveLength(AUTO_RETRY_LIMIT)
    const row: any = await w.rowOf('B-1-1')
    expect(row.status).toBe('failed')
    expect(row.attempt).toBe(AUTO_RETRY_LIMIT + 1)
    expect(awaitsAutoRetry(row)).toBe(false)
  })
})

// ═══════════ 3 · ИСЧЕРПАВ ПОВТОРЫ, РАБОТА ЖДЁТ ЧЕЛОВЕКА — С ПРИЧИНОЙ ══════════════════════

describe('кончились автоповторы — работа зовёт человека, а не ложится молча', () => {
  it('строка несёт причину словами, и обещания следующей попытки на ней больше нет', async () => {
    const w = world()
    await w.setUp()
    for (let n = 0; n <= AUTO_RETRY_LIMIT; n += 1) {
      await w.breakPiece()
      if (n < AUTO_RETRY_LIMIT) await waitAndTick(w, AUTO_RETRY_BASE_MS * 2 ** n)
    }

    const payload: any = await w.read()
    const done = payload.done.find((d: any) => d.id === 'B-1-1')
    expect(done.failed.reason).toBe('provider_error')
    expect(done.failed.reasonLabel).toContain('провайдер')
    // ПОКА ПОВТОРЫ ОСТАВАЛИСЬ — строка говорила о них; теперь сказать нечего, и поле молчит.
    expect(done.failed.repeats).toBeUndefined()

    // И сборка теперь честно сорвана: вопрос владельцу задан, кусок назван.
    const batch = payload.batches.find((b: any) => b.id === 'B-1')
    expect(batch.state).toBe('failed')
    expect(batch.question.itemId).toBe('B-1-1')
    expect(payload.kpis.batchesAwaitingDecision).toBe(1)
  })

  it('пока повторы есть — строка говорит о них номером, а не молчит', async () => {
    const w = world()
    await w.setUp()
    await w.breakPiece()

    const done = ((await w.read()) as any).done.find((d: any) => d.id === 'B-1-1')
    expect(done.failed.repeats).toEqual({ attempt: 1, of: AUTO_RETRY_LIMIT })
  })
})

// ═══════════ 4 · СБОРКА НЕ СОРВАНА, ПОКА У КУСКА ОСТАЮТСЯ АВТОПОВТОРЫ ═════════════════════

describe('сборка ждёт машину, а не человека, пока у куска есть автоповторы', () => {
  it('вопроса владельцу нет, счётчик ждущих сборок — ноль, а состояние не «сорвалась»', async () => {
    const w = world()
    await w.setUp()
    await w.breakPiece()

    const payload: any = await w.read()
    const batch = payload.batches.find((b: any) => b.id === 'B-1')
    expect(batch.state).not.toBe('failed')
    expect(batch.question).toBeUndefined()
    expect(payload.kpis.batchesAwaitingDecision).toBe(0)

    // Одно правило на всех: очередь спрашивается тем же вызовом, каким его спрашивает карточка.
    const items = batchItemsOf(await w.rows(), 'B-1')
    expect(brokenItemOf(items)).toBeNull()
  })

  it('остальные куски всё же придержаны: сборка идёт по одному куску за раз', async () => {
    const w = world()
    await w.setUp()
    await w.breakPiece()

    // Кусок ждёт СВОЕГО повтора — и пока он ждёт, второй кусок вперёд него не уезжает.
    expect(await w.queue.claimNext('w2', {})).toBeNull()
  })
})

// ═══════════ 5 · О ЧЁМ СПРАШИВАЮТ ОЧЕРЕДЬ: ПОСЛЕДНЕЕ СЛОВО, А НЕ ВСЯКАЯ СТРОКА ═════════════

describe('повтор читает последнее слово о задаче', () => {
  /**
   * Долговременная очередь НЕ переписывает закрытую строку: перевыданная задача живёт рядом со
   * своей сорвавшейся. Поэтому «эта задача сорвана» — вопрос к последней строке, а не к любой
   * найденной: без свёртки проход повторил бы работу, которую человек уже вернул и которая с тех
   * пор сделана. Памятная очередь такого состояния не создаёт (у неё одна запись на номер), и
   * потому здесь стоит подставная очередь — ровно на одно это утверждение.
   */
  it('старая сорвавшаяся строка не воскрешает задачу, которая с тех пор сделана', async () => {
    const asked: string[] = []
    const rows = [
      { id: 'T-1', status: 'failed', failure_reason: 'provider_error', attempt: 1, enqueuedAt: 1000, completedAt: 1000 },
      { id: 'T-1', status: 'awaiting_approval', attempt: 2, enqueuedAt: 2000, completedAt: 5000 },
    ]
    const adapter: any = {
      list: async () => rows,
      claimNext: async () => null,
      stats: async () => ({ total: 2 }),
      reissue: async (id: string) => {
        asked.push(id)
        return true
      },
    }
    const journal: any[] = []
    await tick({
      adapter,
      config: { pipeline: { enabled: true }, workers: [] },
      clock: () => 10_000_000,
      journal: (e: any) => journal.push(e),
    } as any)

    expect(asked).toEqual([])
    expect(repeats(journal)).toHaveLength(0)
  })
})

// ═══════════ 6 · ГДЕ АВТОПОВТОР ЗАПРЕЩЁН ══════════════════════════════════════════════════

describe('повторять бессмысленное запрещено, и запрет назван один раз', () => {
  /**
   * КРАСНЫЙ ТЕСТ НА ЗАПРЕТ. Потолок ходов — единственный конец во всей таксономии, за которым
   * нет следующей попытки: потолок ставит сам демон и переносит его на следующую командную
   * строку неизменным, так что повтор упрётся в ту же стену на том же шаге. Автоповтор здесь
   * — это две оплаченные попытки с известным заранее исходом.
   */
  it('потолок ходов не повторяется НИКОГДА, сколько бы ни прошло времени', async () => {
    const w = world()
    await w.setUp()
    const claimed: any = await w.queue.claimNext('w1', {})
    await w.queue.parkForPerson(claimed.id, 'turns_exhausted', { attemptToken: claimed.attemptToken })

    const parked: any = await w.rowOf('B-1-1')
    expect(parked.status).toBe('failed')
    expect(awaitsAutoRetry(parked)).toBe(false)
    expect(Number.isFinite(autoRetryDueAt(parked))).toBe(false)

    for (let i = 0; i < 3; i += 1) {
      w.advance(8 * HOUR)
      await tick(w.deps)
    }
    expect(repeats(w.journal)).toHaveLength(0)
    expect((await w.rowOf('B-1-1')).status).toBe('failed')
    expect((await w.rowOf('B-1-1')).attempt).toBe(1)
  })

  it('пропущенный владельцем кусок не воскресает: его слово главнее автомата', async () => {
    const w = world()
    await w.setUp()
    await w.breakPiece()
    // Слово владельца записывается ТОЙ ЖЕ дверью очереди, какой его пишет ответ с карточки.
    await w.queue.resolveBatch('B-1', { skip: 'B-1-1' })

    await waitAndTick(w, AUTO_RETRY_BASE_MS)
    expect(repeats(w.journal)).toHaveLength(0)
    expect((await w.rowOf('B-1-1')).status).toBe('failed')
    // …а сборка при этом поехала дальше — со следующего куска, как он и просил.
    expect((await w.queue.claimNext('w2', {}))!.id).toBe('B-1-2')
  })

  it('брошенная сборка не повторяет ничего — ни одного своего куска', async () => {
    const w = world()
    await w.setUp()
    await w.breakPiece()
    await w.queue.resolveBatch('B-1', { cancel: true })

    await waitAndTick(w, AUTO_RETRY_BASE_MS)
    expect(repeats(w.journal)).toHaveLength(0)
    expect((await w.rowOf('B-1-1')).status).toBe('failed')
  })

  it('остановленную рукой человека не повторяют: он уже решил', async () => {
    const w = world()
    await w.setUp()
    const claimed: any = await w.queue.claimNext('w1', {})
    expect(await w.queue.cancelTask(claimed.id)).toBe(true)

    w.advance(8 * HOUR)
    await tick(w.deps)
    expect(repeats(w.journal)).toHaveLength(0)
    expect((await w.rowOf('B-1-1')).status).toBe('failed')
  })
})
