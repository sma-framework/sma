/**
 * ВОЗВРАТ КУСКА — ЧЕТВЁРТАЯ ДВЕРЬ, И ЕДИНСТВЕННАЯ, ЧЕРЕЗ КОТОРУЮ СБОРКА РАСКЛЕИВАЛАСЬ МОЛЧА.
 *
 * ═══════════════════════ ОТКУДА ЭТОТ ФАЙЛ ══════════════════════════════════════════════════
 * Правило владельца «одна сборка — один работник» закрыто проводом (`batch-pin-wire.test.ts`),
 * обе двери ПОСТАНОВКИ закрыты тем, что смешать роль и сборку они не дают
 * (`batch-pin-door.test.ts`, `front-state.test.ts`), а дверь ПОВТОРА — тем, что кусок
 * возвращается в свою сборку со своим родством и своей ролью (`batch-pin-retry.test.ts`,
 * `role-survives-return.test.ts`). Из этого следовал вывод, что расклеить сборку через продукт
 * сегодня нельзя. Вывод был неполон: дверей, ставящих кусок в живую сборку ЗАНОВО, не три, а
 * ЧЕТЫРЕ — и четвёртая, `POST /api/return`, родство теряла.
 *
 * ЗАМЕРЕНО. Очередь при повторной постановке под тем же номером строку не дополняет, а
 * ПЕРЕЗАПИСЫВАЕТ целиком: всё, чего дверь не назвала, задача теряет молча. Дверь возврата несла
 * вперёд конверт стадии, полосу, имя, слова, оценку и роль — каждое из них добавлено задним
 * числом, после того как терялось. `batchId` не несла НИ РАЗУ, и это тот же дефект, только
 * платит по нему не задача, а вся сборка.
 *
 * ЦЕНА ПОТЕРИ РОДСТВА — ТРИ ПОСЛЕДСТВИЯ, И ВСЕ ТРИ ЗДЕСЬ ЗАМЕРЕНЫ:
 *   1. Закрепление отпускается, и сказать о нём НЕЧЕГО: `poolFor` спрашивает работника сборки
 *      по `batchId`, а у строки его больше нет — значит вторая попытка куска едет кем попало и
 *      МОЛЧА. Ни `not_in_pool`, ни `role_mismatch` тут не напишутся: обе строки говорят о
 *      сборке, которой у куска не осталось. Ровно та тихая подмена, ради запрета которой
 *      правило и заведено.
 *   2. Сборка перестаёт держать ПОРЯДОК. `batchHeldOf` придерживает куски по родству, и кусок
 *      без него читается как обычная работа: возвращённый кусок и его сосед выдаются ДВУМ
 *      работникам одновременно — сборка физически разъезжается по счетам.
 *   3. Кусок пропадает ИЗ САМОЙ СБОРКИ (`batchItemsOf`): карточка запроса его больше не
 *      показывает, а дверь решения по сборке отвечает о нём 404 — слово владельца «пропустить»
 *      до куска не доходит, потому что дверь ищет его по родству.
 *
 * ЧТО ЗДЕСЬ ЗАКРЫТО: все три последствия. Контроль рядом: возврат обычной работы родства НЕ
 * ВЫДУМЫВАЕТ, и та же работа в том же мире уезжает первому по конфигу — значит случаи ловят
 * закрепление, а не перекошенный пул.
 *
 * ═══════════════════════ ЛЕКАРСТВОМ ОКАЗАЛСЯ НЕ ШЕСТОЙ ПУНКТ ПЕРЕЧНЯ ═══════════════════════
 * Родство можно было дописать шестой строкой к пяти уже стоящим в двери — и следующее поле
 * потерялось бы точно так же. Дверь теперь берёт у очереди НАГРУЗКУ ЦЕЛИКОМ (`payloadOf`), той
 * же стороной, какой её берёт повтор сорвавшейся работы, и накладывает сверху только то, что
 * решает возврат: источник, слово человека, номер подхода, имя из тела запроса. Последний
 * случай этого файла — про то, ради чего перечень пришлось убрать целиком: снимка контекста в
 * читаемой форме строки НЕТ ВООБЩЕ, и перечислением полей его было не спасти.
 *
 * ЧЕГО НЕ ДОКАЗЫВАЕТ: ни выбора работника самого по себе (`batch-pin-wire.test.ts`), ни спора
 * дверей за строку (CAS здесь заглушка, свой случай — в `front-auth.test.ts`), ни прочего тела
 * двери возврата (`front-state.test.ts`).
 *
 * Ни один случай не поднимает процесс, не ходит в сеть и не пишет на диск: очередь в памяти,
 * двери настоящие, вербы — записи, работник — функция, окна — предикат.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { tick } from '../src/loop.mjs'
import { createMemoryQueue, batchItemsOf, batchWorkerOf, taskContextOf } from '../src/queue/adapter.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

/** Ночь: дневная защита счёта владельца не участвует, единственная причина — окно. */
const NIGHT = () => new Date(2026, 7, 31, 2, 0, 0).getTime()

const account = { name: 'local-1', configDir: 'C:\\accounts\\local-1' }

/** Исполнитель — тот, кто пишет код: описание агента у всех копий одно. */
const executor = (id: string) => ({
  id,
  lane: 'prod',
  provider: 'claude',
  enabled: true,
  account,
  roleFile: '.claude/agents/sma-executor.md',
  model: 'opus',
})

/** ПОРЯДОК ЗДЕСЬ — ЧАСТЬ ПРОВЕРКИ: сборку поведёт второй, а первый всё это время доступен. */
const POOL = [executor('sma-executor'), executor('sma-executor-2')]

const TOKEN = 'd'.repeat(64)

const GREEN_REVERIFY = {
  code: 0,
  stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:ok', diffStat: '+10 -2' }),
}

function mkReq(url: string, body: unknown) {
  const req: any = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(code: number) {
      res.statusCode = code
      res.headersSent = true
      return res
    },
    setHeader() {},
    getHeader() {
      return undefined
    },
    write(chunk: any) {
      res.body += String(chunk)
      return true
    },
    end(chunk?: any) {
      if (chunk != null) res.body += String(chunk)
      return res
    },
  }
  return res
}

/**
 * МИР ОДНОГО ПРОГОНА: настоящая очередь в памяти, настоящий тик, настоящий маршрутизатор — и
 * НАСТОЯЩИЕ ДВЕРИ поверх той же очереди. Сборку ставит `POST /api/batch`, слово «переделай»
 * приносит `POST /api/return`: подделать возврат строкой в фикстуре значило бы проверить
 * фикстуру, а весь случай — ровно в том, ЧТО ИМЕННО дверь кладёт в очередь.
 *
 * `casExec` — заглушка того места, где дверь возврата спорит за строку с другой дверью. Спор
 * здесь не проверяется (он свой в `front-auth.test.ts`); важно лишь, что дверь дошла до
 * постановки задачи заново.
 */
function world({ workers = POOL, closed = new Set<string>() } = {}) {
  const queue = createMemoryQueue({ clock: NIGHT, expireMs: 300_000 })
  const journalled: any[] = []
  const deps: any = {
    adapter: queue,
    ledger: { recordAttempt: (a: any) => a, readAttempts: () => [] },
    config: { workers, agingHours: 24, backlogScanMinutes: 60, repoDir: '/repo', pipeline: { enabled: true } },
    routing: { resolveRoute },
    windows: (w: any) => !closed.has(w && w.id),
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
    verbRunner: async (_bin: string, argsArray: string[]) => {
      const verb = argsArray[1]
      if (verb === 'worktree') return { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/x', branch: 'wt/x' }) }
      if (verb === 'reverify') return GREEN_REVERIFY
      return { code: 0, stdout: '{}' }
    },
    spawnWorker: (spec: any) => {
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    report: async () => {},
    clock: NIGHT,
    journal: (e: any) => journalled.push(e),
  }
  const front = createFrontServer({
    config: { token: TOKEN, workers: [] },
    deps: { clock: NIGHT, adapter: queue, taskTable: 'sma_task_attempts', casExec: async () => ({ rows: [{ id: 'won' }] }) },
  })
  const call = async (url: string, body: unknown) => {
    const res = mkRes()
    await front.handle(mkReq(url, body), res)
    return res
  }
  return { queue, deps, journalled, closed, call }
}

/** Кто в итоге вёл этот кусок — по ПОСЛЕДНЕЙ строке очереди, а не по решению маршрута. */
const workerOf = async (queue: any, id: string) => {
  const rows = await queue.list({})
  const row = rows.filter((r: any) => r.id === id).pop()
  return row ? row.workerId : null
}

/** Последняя строка задачи целиком — то, чем задача стала после последней двери. */
const rowOf = async (queue: any, id: string) => {
  const rows = await queue.list({})
  return rows.filter((r: any) => r.id === id).pop() ?? null
}

/**
 * Сборка из трёх кусков, у которой ДВА ПЕРВЫХ отработаны и стоят на подтверждении, и ведёт её
 * ВТОРОЙ по конфигу работник.
 *
 * Как сборка досталась второму: на первом куске окно первого закрыто — и тут же возвращается,
 * так что дальше выбор объясняется ТОЛЬКО закреплением. Тот же приём держит соседний провод
 * (`batch-pin-wire.test.ts`): совпади работник сборки с первой строкой конфига, случай был бы
 * зелёным и при полностью выключенном правиле.
 *
 * ПОЧЕМУ КУСКОВ ОТРАБОТАЛО ДВА, А ВОЗВРАЩАЕТСЯ ПЕРВЫЙ. Работник сборки не хранится — он
 * читается с её кусков, и у куска, которого прямо сейчас выдают, СЕБЯ НЕ СПРАШИВАЮТ
 * (`exceptId`), иначе ответом на вопрос был бы вопрос. Отработай в сборке только тот кусок,
 * который возвращают, — прочитать закрепление стало бы не с чего, и это ОТДЕЛЬНАЯ, замеренная
 * граница со своим случаем (`batch-pin-retry.test.ts`, `no_worked_neighbour`); ниже она названа
 * своим случаем и здесь. Этот файл про РОДСТВО: чтобы он говорил о родстве, а не о той границе,
 * у сборки есть отработавший сосед.
 */
async function assemblyAwaitingWord() {
  const closed = new Set<string>(['sma-executor'])
  const w = world({ closed })
  const created = await w.call('/api/batch', { title: 'разбор', items: ['первое', 'второе', 'третье'] })
  expect(created.statusCode).toBe(200)
  const batchId = JSON.parse(created.body).id

  await tick(w.deps) // кусок 1 — первому по конфигу нельзя, ведёт второй
  closed.delete('sma-executor') // окно вернулось: дальше всё решает закрепление
  await tick(w.deps) // кусок 2 — за тем же, и уже только по закреплению

  const held = await workerOf(w.queue, `${batchId}-1`)
  expect(held).toBe('sma-executor-2')
  expect(await workerOf(w.queue, `${batchId}-2`)).toBe('sma-executor-2')
  return { ...w, batchId, held, itemId: `${batchId}-1` }
}

// ═════════ 1 · «ПЕРЕДЕЛАЙ» ВОЗВРАЩАЕТ КУСОК В СБОРКУ, А НЕ В ОБЩИЙ ПУЛ ══════════════════════

describe('возврат куска: сборка остаётся сборкой', () => {
  it('возвращённый кусок несёт своё родство — и вторую попытку ведёт работник СБОРКИ', async () => {
    const { queue, deps, call, batchId, held, itemId } = await assemblyAwaitingWord()

    const back = await call('/api/return', { taskId: itemId, note: 'не то, переделай' })
    expect(back.statusCode).toBe(200)

    // ВОТ ЕДИНСТВЕННАЯ СТРОКА, НА КОТОРОЙ ДЕРЖИТСЯ ВСЁ ОСТАЛЬНОЕ. Пропади `batchId` из тела
    // повторной постановки — кусок перестаёт быть куском этой сборки, и следующий тик увезёт
    // его кому угодно, не сказав об этом ни слова.
    const again = await rowOf(queue, itemId)
    expect(again.status).toBe('queued')
    expect(again.attempt).toBe(2)
    expect(again.batchId).toBe(batchId)
    expect(batchWorkerOf(await queue.list({}), batchId, itemId)).toBe(held)

    // И ЭТО НЕ УТВЕРЖДЕНИЕ О ПОЛЕ, А О РАБОТНИКЕ: окно первого по конфигу открыто, он свободен,
    // и всё же вторую попытку ведёт тот, кто вёл первую.
    await tick(deps)
    expect(await workerOf(queue, itemId)).toBe(held)
  })

  it('контроль: та же дверь, обычная работа — родства не выдумывает и едет первому по конфигу', async () => {
    // Обратная сторона того же шва. «Работа сборки» и «работа сама по себе» — разные факты, и
    // дверь, дописывающая родство от себя, стёрла бы различие так же молча, как раньше стирала
    // само родство. Заодно это замер пула: та же очередь, тот же проход — и работа без сборки
    // уезжает первому по конфигу, значит предыдущий случай ловит закрепление, а не перекос.
    const { queue, deps, call, closed } = world({ closed: new Set(['sma-executor']) })
    await queue.enqueue({ id: 'R-1', source: 'roster', title: 'обычная работа', lane: 'prod' })

    await tick(deps)
    expect(await workerOf(queue, 'R-1')).toBe('sma-executor-2')
    closed.delete('sma-executor')

    expect((await call('/api/return', { taskId: 'R-1', note: 'переделай' })).statusCode).toBe(200)
    const again = await rowOf(queue, 'R-1')
    expect(again.batchId ?? null).toBeNull()

    await tick(deps)
    expect(await workerOf(queue, 'R-1')).toBe('sma-executor')
  })
})

// ═════════ 2 · ПОРЯДОК СБОРКИ: ПО ОДНОМУ КУСКУ ЗА РАЗ, И ПОСЛЕ ВОЗВРАТА ТОЖЕ ════════════════

describe('возврат куска не выпускает сборку на двух работников сразу', () => {
  it('после «переделай» очередь по-прежнему отдаёт ОДИН кусок этой сборки', async () => {
    // `batchHeldOf` придерживает куски ПО РОДСТВУ, и кусок без него читается как обычная
    // работа. Потеряй возврат `batchId` — возвращённый кусок и его сосед выдаются двум разным
    // работникам в один и тот же момент: сборка расклеивается не в переносном смысле, а
    // физически, по счетам.
    const { queue, call, itemId } = await assemblyAwaitingWord()
    expect((await call('/api/return', { taskId: itemId, note: 'переделай' })).statusCode).toBe(200)

    const first = await queue.claimNext('sma-executor-2', {})
    expect(first && first.id).toBe(itemId) // возвращённый кусок держит СВОЁ место, а не хвост

    const second = await queue.claimNext('sma-executor', {})
    expect(second ?? null).toBeNull()
  })
})

// ═════════ 3 · КУСОК ОСТАЁТСЯ В СБОРКЕ ДЛЯ ЧЕЛОВЕКА, А НЕ ТОЛЬКО ДЛЯ МАРШРУТА ═══════════════

describe('возвращённый кусок остаётся куском сборки и для человека', () => {
  it('сборка показывает все свои куски, а слово владельца о возвращённом доходит', async () => {
    // Куски сборки читаются по родству (`batchItemsOf`) — и карточкой запроса, и дверью
    // решения. Кусок, потерявший родство, пропадает из сборки: она выглядит короче, чем её
    // заказали, а `POST /api/batch/decide` отвечает о нём 404 — то есть сказать «пропустить»
    // про работу, которую человек только что вернул, стало НЕЛЬЗЯ.
    const { queue, call, batchId, itemId } = await assemblyAwaitingWord()
    expect((await call('/api/return', { taskId: itemId, note: 'переделай' })).statusCode).toBe(200)

    const items = batchItemsOf(await queue.list({}), batchId).map((r: any) => r.id)
    expect(items).toEqual([`${batchId}-1`, `${batchId}-2`, `${batchId}-3`])

    // Дверь кусок НАХОДИТ: 409 — это ответ о найденном куске («не он остановил сборку»),
    // а 404 был бы ответом «такого куска в этой сборке нет».
    const decided = await call('/api/batch/decide', { batchId, decision: 'skip', itemId })
    expect(decided.statusCode).toBe(409)
  })
})

// ═════════ 4 · ГРАНИЦА РЯДОМ: ВЕРНУЛИ ЕДИНСТВЕННЫЙ ОТРАБОТАВШИЙ КУСОК ═══════════════════════

describe('возврат единственного отработавшего куска: родство цело, а закрепление нечитаемо', () => {
  it('кусок остаётся в сборке, но работника прочитать не с чего — и об этом СКАЗАНО', async () => {
    // Родство и закрепление — РАЗНЫЕ факты, и эта пара их разводит. Родство дверь несёт: кусок
    // остаётся куском сборки. А вот работника сборки читают с ЕЁ КУСКОВ, и у выдаваемого себя
    // не спрашивают; если больше никто в сборке не отработал, читать нечего — тот же случай,
    // что у повтора (`batch-pin-retry.test.ts`). Кому доставаться такому куску — решение
    // владельца; чего тик делать не вправе — так это молчать о том, что выбор сделан.
    const closed = new Set<string>(['sma-executor'])
    const w = world({ closed })
    const created = await w.call('/api/batch', { title: 'разбор', items: ['первое', 'второе'] })
    const batchId = JSON.parse(created.body).id
    await tick(w.deps)
    closed.delete('sma-executor')
    const itemId = `${batchId}-1`
    expect(await workerOf(w.queue, itemId)).toBe('sma-executor-2')

    expect((await w.call('/api/return', { taskId: itemId, note: 'переделай' })).statusCode).toBe(200)

    // РОДСТВО ЦЕЛО — это и есть починка двери, и она от границы не зависит.
    const again = await rowOf(w.queue, itemId)
    expect(again.batchId).toBe(batchId)
    // А закрепление — нечитаемо, и это не молчание, а названная причина.
    expect(batchWorkerOf(await w.queue.list({}), batchId, itemId)).toBeNull()

    await tick(w.deps)
    const unreadable = w.journalled.filter((e: any) => e.type === 'batch.pin_unreadable')
    expect(unreadable.length).toBeGreaterThan(0)
    expect(unreadable[0]).toMatchObject({ taskId: itemId, batchId, reason: 'no_worked_neighbour' })
  })
})

// ═════════ 5 · ТА ЖЕ ДВЕРЬ НЕСЁТ И ТО, ЧЕГО В ЧИТАЕМОЙ СТРОКЕ НЕТ ВООБЩЕ ════════════════════

describe('возврат ставит ТУ ЖЕ работу — целиком, а не её читаемый огрызок', () => {
  it('снимок контекста переживает «переделай» — работник второй попытки получает то же, что и первой', async () => {
    // ПОЧЕМУ ЭТОТ СЛУЧАЙ ЗДЕСЬ, А НЕ В СВОЁМ ФАЙЛЕ: он про ТУ ЖЕ дверь и ТУ ЖЕ починку. Родство
    // ещё можно было дописать шестым пунктом к перечню полей — снимок нельзя: его нет в
    // читаемой форме строки НАМЕРЕННО (он не едет в каждый полл окна, см. row() в очереди), и
    // дверь, собирающая задачу из `list`, теряла бы его при любой внимательности. Спрашивают
    // его у ВЫДАЧИ, а не у списка: работник получает нагрузку, а не строку.
    const { queue, call } = world()
    const snapshot = 'счета лежат в /invoices, доступ у Ольги'
    await queue.enqueue({
      id: 'R-2',
      source: 'roster',
      title: 'свести счета',
      lane: 'prod',
      description: 'сверить два реестра',
      taskContext: snapshot,
    })

    const first = await queue.claimNext('sma-executor', {})
    expect(taskContextOf(first)).toBe(snapshot)
    await queue.complete('R-2', { receiptRef: 'reverify:ok', attemptToken: first.attemptToken })

    expect((await call('/api/return', { taskId: 'R-2', note: 'не то, переделай' })).statusCode).toBe(200)

    const second = await queue.claimNext('sma-executor', {})
    expect(second.id).toBe('R-2')
    expect(second.attempt).toBe(2)
    expect(second.description).toBe('сверить два реестра')
    expect(taskContextOf(second)).toBe(snapshot)
  })
})
