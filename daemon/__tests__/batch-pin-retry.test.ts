/**
 * ПОВТОР КУСКА — ТРЕТЬЯ ДВЕРЬ, ЧЕРЕЗ КОТОРУЮ СБОРКА МОЖЕТ СМЕНИТЬ РАБОТНИКА.
 *
 * ═══════════════════════ ОТКУДА ЭТОТ ФАЙЛ ══════════════════════════════════════════════════
 * Правило «одна сборка — один работник» закрыто проводом (`batch-pin-wire.test.ts`), а обе
 * двери ПОСТАНОВКИ — тем, что смешать роль и сборку они не дают (`batch-pin-door.test.ts`,
 * `front-state.test.ts`). Из этого был сделан вывод, что расклеить сборку по разным работникам
 * через продукт сегодня нельзя. Замер показал, что дверей, пишущих кусок В ЖИВУЮ СБОРКУ, не
 * две, а ТРИ: `POST /api/batch/decide` со словом «повторить» ставит кусок обратно в очередь —
 * тот же id, та же сборка, один подход выше (`front/server.mjs`, ветка retry).
 *
 * И это не рядовая дверь, а самая опасная из трёх. Первые две пишут куски, которых ещё никто не
 * вёл; эта — кусок, который УЖЕ вели, то есть ровно тот случай, ради которого правило и заведено:
 * работник, сломавшийся на куске, держит его копию и всё, что успел про него понять. Уйдёт
 * повтор на другой счёт — выученное оплачивается заново, и именно на повторе это дороже всего.
 *
 * ═══════════════════════ ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ ═════════════════════════════════════════
 *   1. Повтор возвращается работнику СБОРКИ, а не первому по конфигу, — и это утверждение о
 *      закреплении: работник сборки в конфиге стоит ВТОРЫМ, а окно первого в момент повтора
 *      открыто. Случай красный с двух сторон: убрать `batchId` из тела повтора (одна строка в
 *      двери) — красный; отнять у `poolFor` предпочтение — красный.
 *   2. И первое не заявлено, а ЗАМЕРЕНО соседним случаем: тот же кусок, поставленный обратно
 *      без имени сборки, уезжает первому по конфигу. Замер сделан СИМУЛЯЦИЕЙ, а не правкой
 *      двери: в этом дереве в тот момент работали другие сессии, и мутация чужого файла
 *      попала бы в чужой коммит.
 *   3. Контроль рядом: обычная работа в той же очереди и в том же проходе уезжает первому по
 *      конфигу. Значит проверка ловит закрепление, а не перекошенный пул.
 *
 * ═══════════════════════ ЗАМЕРЕННАЯ ГРАНИЦА — ВОПРОС, А НЕ ПРИГОВОР ═══════════════════════
 * Третий случай закрепляет то, что СЕГОДНЯ ПРОИСХОДИТ, и это поведение названо здесь словами
 * именно потому, что оно спорное. Если единственный отработавший кусок сборки — тот самый,
 * который повторяют, закрепление после повтора прочитать не с чего:
 *
 *   • дверь повтора ставит строку заново, и `workerId` на ней пустой (`enqueue` его обнуляет);
 *   • `batchWorkerOf` строку повторяемого куска исключает НАРОЧНО (`exceptId`) — иначе она
 *     ответила бы на вопрос вопросом, назвав работником сборки того, кого только выбирают;
 *   • соседи ещё не отработали и работника не называют.
 *
 * Пул возвращается порядком конфига, кусок уезжает ДРУГОМУ работнику, и в журнале об этом НЕ
 * СКАЗАНО НИ СЛОВА: `poolFor` молчит на пустом закреплении, потому что так же выглядит первый
 * кусок свежей сборки, о котором сказать нечего. Здесь сказать есть что — работник у сборки был.
 *
 * ЧЕГО ЭТОТ СЛУЧАЙ НЕ УТВЕРЖДАЕТ: что так правильно. Должен ли повтор возвращаться тому, кто на
 * куске сломался (у него копия и контекст), или наоборот уходить на свежий счёт (сломавшийся уже
 * исчерпал автоповторы) — это решение владельца, и угадывать его тест не станет. Он делает
 * ровно одно: следующая правка этого места будет ОСОЗНАННОЙ, а не тихой.
 *
 * Ни один случай не поднимает процесс, не ходит в сеть и не пишет на диск: очередь в памяти,
 * дверь — настоящая, вербы — записи, работник — функция, окна — предикат.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { tick, poolFor } from '../src/loop.mjs'
import { createMemoryQueue, batchWorkerOf, AUTO_RETRY_LIMIT } from '../src/queue/adapter.mjs'
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

const TOKEN = 'b'.repeat(64)

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
 * НАСТОЯЩИЕ ДВЕРИ поверх той же очереди. Сборку ставит `POST /api/batch`, слово владельца
 * приносит `POST /api/batch/decide`: подделать повтор строкой в фикстуре значило бы проверить
 * фикстуру, а вся суть случая — в том, ЧТО ИМЕННО дверь кладёт в очередь.
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
  const front = createFrontServer({ config: { token: TOKEN, workers: [] }, deps: { clock: NIGHT, adapter: queue } })
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

/**
 * Ломает следующий выданный кусок НАСМЕРТЬ руками названного работника.
 *
 * Именно насмерть, а не однажды: пока автоповторы у куска есть, сборка ждёт очередь, а не
 * человека, и двери `decide` отвечать нечего — вопроса при сборке ещё нет.
 */
async function breakDead(queue: any, worker: string) {
  let claimed = await queue.claimNext(worker, {})
  for (let n = 0; n <= AUTO_RETRY_LIMIT; n += 1) {
    await queue.fail(claimed.id, 'tests_red', { attemptToken: claimed.attemptToken })
    if (n === AUTO_RETRY_LIMIT) break
    await queue.reissue(claimed.id)
    claimed = await queue.claimNext(worker, {})
  }
  return claimed
}

/**
 * Сборка из трёх кусков, которую ведёт ВТОРОЙ по конфигу работник, с третьим куском, сломанным
 * насмерть и ждущим слова владельца.
 *
 * Как сборка досталась второму: на первом куске окно первого закрыто — и тут же возвращается,
 * так что дальше выбор объясняется только закреплением. Ровно этот приём держит соседний
 * провод (`batch-pin-wire.test.ts`), и здесь он нужен по той же причине: совпади работник
 * сборки с первой строкой конфига, случай был бы зелёным и при полностью выключенном правиле.
 */
async function stoppedAssembly() {
  const closed = new Set<string>(['sma-executor'])
  const w = world({ closed })
  const created = await w.call('/api/batch', { title: 'разбор', items: ['первое', 'второе', 'третье'] })
  expect(created.statusCode).toBe(200)
  const batchId = JSON.parse(created.body).id

  await tick(w.deps) // кусок 1 — первому по конфигу нельзя, ведёт второй
  closed.delete('sma-executor') // окно вернулось: дальше всё решает закрепление
  await tick(w.deps) // кусок 2 — за тем же

  const held = await workerOf(w.queue, `${batchId}-1`)
  expect(held).toBe('sma-executor-2')
  expect(await workerOf(w.queue, `${batchId}-2`)).toBe('sma-executor-2')

  const broken = await breakDead(w.queue, held)
  expect(broken.id).toBe(`${batchId}-3`)
  return { ...w, batchId, held, brokenId: broken.id }
}

// ═════════ 1 · ПОВТОР ВОЗВРАЩАЕТСЯ РАБОТНИКУ СБОРКИ ══════════════════════════════════════════

describe('«повторить» — кусок возвращается в сборку, а не в общий пул', () => {
  it('повтор уезжает работнику СБОРКИ, хотя первый по конфигу свободен и с открытым окном', async () => {
    const { queue, deps, call, batchId, held, brokenId } = await stoppedAssembly()

    const decided = await call('/api/batch/decide', { batchId, decision: 'retry', itemId: brokenId })
    expect(decided.statusCode).toBe(200)
    expect(JSON.parse(decided.body)).toMatchObject({ ok: true, batchId, decision: 'retry', itemId: brokenId })

    // Дверь положила кусок обратно БЕЗ работника — строка чистая, как у всякой поставленной
    // работы. Значит закрепление на ней не написано и читается только со сборки.
    const rows = await queue.list({})
    const again = rows.filter((r: any) => r.id === brokenId).pop()
    expect(again.status).toBe('queued')
    expect(again.workerId ?? null).toBeNull()
    // И ВОТ ЕДИНСТВЕННАЯ СТРОКА, НА КОТОРОЙ ДЕРЖИТСЯ ВСЁ: пропади `batchId` из тела повтора —
    // кусок перестанет быть куском этой сборки, и следующий тик увезёт его кому угодно.
    expect(again.batchId).toBe(batchId)
    expect(batchWorkerOf(rows, batchId, brokenId)).toBe(held)

    await tick(deps)
    expect(await workerOf(queue, brokenId)).toBe(held)
  })

  it('симулированная подмена: тот же кусок обратно БЕЗ `batchId` — и он уезжает другому', async () => {
    const { queue, deps, held, brokenId } = await stoppedAssembly()

    // ЧУЖОЙ ФАЙЛ НЕ ПРАВИМ — воспроизводим ровно то, что дверь положила бы, потеряй она одну
    // строку: тот же id, тот же подход, тот же `source: 'return'`, но без имени сборки. Так
    // утверждение «на этой строке держится всё» становится ЗАМЕРОМ, а не словом в шапке.
    await queue.enqueue({ id: brokenId, source: 'return', title: 'третье', lane: 'prod', attempt: 2 })
    await tick(deps)

    expect(await workerOf(queue, brokenId)).not.toBe(held)
    expect(await workerOf(queue, brokenId)).toBe('sma-executor')
  })

  it('контроль: обычная работа в той же очереди уезжает первому по конфигу', async () => {
    const { queue, deps, call, batchId, brokenId } = await stoppedAssembly()
    await call('/api/batch/decide', { batchId, decision: 'retry', itemId: brokenId })

    // Та же очередь, тот же пул, тот же проход — и работа БЕЗ сборки идёт по конфигу. Значит
    // предыдущий случай ловит закрепление, а не пул, перекошенный на весь мир.
    await queue.enqueue({ id: 'T-одиночка', source: 'roster', title: 'одиночная работа', lane: 'prod' })
    await tick(deps)
    await tick(deps)

    expect(await workerOf(queue, brokenId)).toBe('sma-executor-2')
    expect(await workerOf(queue, 'T-одиночка')).toBe('sma-executor')
  })
})

// ═════════ 2 · ЗАМЕРЕННАЯ ГРАНИЦА: ЕДИНСТВЕННЫЙ ОТРАБОТАВШИЙ КУСОК — ЭТО ОН САМ ══════════════

describe('сборка, у которой отработал ТОЛЬКО повторяемый кусок, закрепление теряет', () => {
  it('после повтора работника сборки прочитать не с чего — и смена проходит МОЛЧА', async () => {
    const { queue, deps, call, journalled } = world()
    const created = await call('/api/batch', { title: 'разбор', items: ['первое', 'второе'] })
    const batchId = JSON.parse(created.body).id

    // Сборку ведёт второй по конфигу — и на первом же куске ломается насмерть. Соседний кусок
    // ещё не выдавался и работника не называет.
    const held = 'sma-executor-2'
    const broken = await breakDead(queue, held)
    expect(broken.id).toBe(`${batchId}-1`)
    expect(batchWorkerOf(await queue.list({}), batchId, `${batchId}-2`)).toBe(held)

    const decided = await call('/api/batch/decide', { batchId, decision: 'retry', itemId: broken.id })
    expect(decided.statusCode).toBe(200)

    // ТРИ ПРИЧИНЫ СРАЗУ, И КАЖДАЯ САМА ПО СЕБЕ ДОСТАТОЧНА: строка поставлена заново и работника
    // не несёт; себя же спрашивать нельзя (`exceptId`); сосед ещё молчит.
    const rows = await queue.list({})
    expect(rows.filter((r: any) => r.id === broken.id).pop().workerId ?? null).toBeNull()
    expect(batchWorkerOf(rows, batchId, broken.id)).toBeNull()

    // Значит пул — ровно порядок конфига, и повтор уезжает НЕ ТОМУ, кто на нём сломался.
    expect((await poolFor(deps, { id: broken.id, batchId })).map((w: any) => w.id)).toEqual([
      'sma-executor',
      'sma-executor-2',
    ])
    await tick(deps)
    expect(await workerOf(queue, broken.id)).toBe('sma-executor')
    expect(await workerOf(queue, broken.id)).not.toBe(held)

    // И ВОТ ЭТО — САМА ЖАЛОБА, А НЕ ЕЁ ПОСЛЕДСТВИЕ: сборка сменила работника, и тик об этом
    // промолчал. `poolFor` называет словами только те два случая, где закрепление ЕСТЬ и он его
    // отпускает (`not_in_pool`, `role_mismatch`); здесь закрепление стало нечитаемым, и молчание
    // объясняется тем, что так же выглядит первый кусок свежей сборки. Здесь — не так.
    expect(journalled.filter((e: any) => e.type === 'batch.pin_let_go')).toHaveLength(0)
    expect(journalled.filter((e: any) => e.type === 'batch.pin_unreadable')).toHaveLength(0)
  })

  it('а с отработавшим соседом та же сборка закрепление держит — граница проходит ровно здесь', async () => {
    const { queue, deps, call, batchId, held, brokenId } = await stoppedAssembly()
    await call('/api/batch/decide', { batchId, decision: 'retry', itemId: brokenId })

    // Разница с предыдущим случаем ровно одна: у этой сборки есть кусок, который отработал и
    // назвал работника. Его и читают — поэтому повтор возвращается домой.
    expect(batchWorkerOf(await queue.list({}), batchId, brokenId)).toBe(held)
    await tick(deps)
    expect(await workerOf(queue, brokenId)).toBe(held)
  })
})
