/**
 * ОДНА СБОРКА — ОДИН РАБОТНИК: ПРАВИЛО, КОТОРОЕ ЖИЛО БЕЗ ЕДИНОЙ ПРОВЕРКИ.
 *
 * ═══════════════════════ ЧТО ВСКРЫЛ ЗАМЕР ══════════════════════════════════════════════════
 * `poolFor` (src/loop.mjs) — вся реализация правила владельца «один работник, по одному куску
 * за раз»: пул отдаётся маршрутизатору с работником ЭТОЙ сборки первым, чтобы следующий кусок
 * достался тому же, кто вёл предыдущий. Аудит 31.08 замерил руками: имя `poolFor` не
 * упоминалось НИ В ОДНОМ тесте этого дерева. Правило держалось на честном слове одной строки.
 *
 * И оно уже менялось молча. После de2637ec («работники и агенты — это разное») фильтр роли в
 * маршрутизаторе стоит ПЕРВЫМ — до `enabled`, провайдера и окна, — и закреплённого за сборкой
 * СПЕЦИАЛИСТА он отбрасывает раньше, чем порядок пула успевает что-то значить. Замер:
 *
 *   • сборка, закреплённая за ИСПОЛНИТЕЛЕМ, держится за ним — правило работает;
 *   • сборка, закреплённая за СПЕЦИАЛИСТОМ, теряет закрепление на первом же куске без слова
 *     о роли, и кусок молча уезжает исполнителю.
 *
 * Второе в коде названо «предпочтение, а не замок» — но там же обещано, что тик «скажет об
 * этом в своём журнале, а не даст перемене случиться молча», и вот ЭТОГО не было: строка
 * писалась только когда очередь бросила исключение. Следующая правка маршрута могла тихо
 * расклеить сборку по разным работникам, и ни один прогон бы не покраснел.
 *
 * ═══════════════════════ ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ ═════════════════════════════════════════
 *   1. ПРОВОД ЧЕРЕЗ НАСТОЯЩИЙ ТИК: четыре куска одной сборки достаются ОДНОМУ работнику от
 *      первого до последнего — и это утверждение о ЗАКРЕПЛЕНИИ, а не о порядке строк конфига:
 *      первый кусок уводится со стоящего первым работника закрытым окном, окно возвращается,
 *      и остальные три всё равно едут за ним. Контроль рядом: те же куски БЕЗ `batchId`
 *      расходятся обратно на первого по конфигу — значит проверка ловит именно правило.
 *   2. КРАСНЫЙ СЛУЧАЙ ПОДМЕНЫ, с двух сторон сразу. Сборка закреплена за специалистом, кусок
 *      роли не назвал: он едет ИСПОЛНИТЕЛЮ (подмени закрепление роль — работа под чужим
 *      описанием агента, ровно то, что чинил de2637ec), и расклейка НАЗВАНА СЛОВАМИ в журнале
 *      тика. Убрать слова — красный; отдать закрепление роли — тоже красный.
 *   3. САМ `poolFor`, прямыми случаями: чего он не трогает, что предпочитает, по каким
 *      названным причинам отпускает закрепление и как отвечает на упавшую очередь.
 *
 * ЧЕГО НЕ ДОКАЗЫВАЕТ. Ни словаря ролей (`worker-role.test.ts`), ни закрытого словаря причин
 * диспетчера (`dispatch-reason-wire.test.ts`), ни очереди сборок (`batch-stall-wire.test.ts`).
 * Здесь — ровно правило «одна сборка — один работник» и его граница с ролью.
 *
 * Ни один случай не поднимает процесс, не ходит в сеть и не пишет на диск: очередь в памяти,
 * вербы — записи, работник — функция, окна — предикат.
 */

import { describe, it, expect } from 'vitest'

import { tick, poolFor } from '../src/loop.mjs'
import { createMemoryQueue, BATCH_PARENT } from '../src/queue/adapter.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

/** Ночь: дневная защита счёта владельца не участвует, единственные причины — окно и роль. */
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

/** Специалист — тот, у кого СВОЁ описание агента; его берут только поимённо. */
const specialist = (id: string) => ({
  id,
  lane: 'prod',
  provider: 'claude',
  enabled: true,
  account,
  roleFile: `.claude/agents/${id}.md`,
  model: 'sonnet',
})

/** Пул того вида, в каком он и стоит у владельца: специалист впереди, исполнители следом. */
const POOL = [specialist('sma-ai-researcher'), executor('sma-executor'), executor('sma-executor-2')]

const GREEN_REVERIFY = {
  code: 0,
  stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:ok', diffStat: '+10 -2' }),
}

/**
 * МИР ОДНОГО ПРОГОНА: настоящая очередь в памяти, настоящий тик, настоящий маршрутизатор.
 *
 * Кусок доводится до конца ТЕМ ЖЕ путём, каким его доводит работа — верб копии, зелёная
 * перепроверка, работник, оставивший записку и слово об уроке. Подделать «строку с работником»
 * полем в фикстуре значило бы проверить фикстуру: `workerId` на строке ставит `assignWorker`
 * внутри тика, и только он.
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
  return { queue, deps, journalled, closed }
}

/** Ставит куски и — ПОСЛЕДНЕЙ — саму постановку, тем же порядком, каким их пишет дверь батча. */
async function enqueueBatch(queue: any, batchId: string, pieces: Array<Record<string, unknown>>) {
  for (let i = 0; i < pieces.length; i += 1) {
    await queue.enqueue({
      id: `${batchId}-${i + 1}`,
      source: 'roster',
      title: `кусок ${i + 1}`,
      lane: 'prod',
      batchId,
      ...pieces[i],
    })
  }
  await queue.enqueue({
    id: batchId,
    source: 'roster',
    title: 'постановка',
    lane: 'prod',
    batchId,
    data: { batch: BATCH_PARENT, requestedAt: NIGHT() },
  })
}

/** Кто в итоге вёл этот кусок — по строке очереди, а не по решению маршрута. */
const workerOf = async (queue: any, id: string) => {
  const rows = await queue.list({})
  const row = rows.filter((r: any) => r.id === id).pop()
  return row ? row.workerId : null
}

// ═════════ 1 · ПРОВОД: КУСКИ ОДНОЙ СБОРКИ ДОСТАЮТСЯ ОДНОМУ РАБОТНИКУ ══════════════════════

describe('одна сборка — один работник, от первого куска до последнего', () => {
  it('четыре куска уходят одному, и это закрепление, а не порядок строк конфига', async () => {
    // Первым в конфиге стоит `sma-executor`; на первом куске его окно закрыто, поэтому сборка
    // закрепляется за ВТОРЫМ. Дальше окно возвращается — и если бы правила не было, куски
    // поехали бы обратно к первому по порядку.
    const w = world({ closed: new Set(['sma-executor']) })
    await enqueueBatch(w.queue, 'B-1', [{}, {}, {}, {}])

    expect((await tick(w.deps)).completed).toBe('B-1-1')
    expect(await workerOf(w.queue, 'B-1-1')).toBe('sma-executor-2')

    w.closed.delete('sma-executor') // окно первого снова открыто — соблазн есть, и он отвергнут

    for (const n of [2, 3, 4]) expect((await tick(w.deps)).completed).toBe(`B-1-${n}`)

    const drivers = await Promise.all([1, 2, 3, 4].map((n) => workerOf(w.queue, `B-1-${n}`)))
    expect(drivers).toEqual(['sma-executor-2', 'sma-executor-2', 'sma-executor-2', 'sma-executor-2'])
    expect(new Set(drivers).size).toBe(1)
  })

  it('контроль: те же куски БЕЗ сборки расходятся обратно на первого по конфигу', async () => {
    // Тот же мир, то же окно, та же последовательность — убран только `batchId`. Если этот
    // случай зелёный, а предыдущий тоже, то предыдущий говорит именно о закреплении.
    const w = world({ closed: new Set(['sma-executor']) })
    for (const n of [1, 2, 3, 4]) {
      await w.queue.enqueue({ id: `R-${n}`, source: 'roster', title: `работа ${n}`, lane: 'prod' })
    }

    expect((await tick(w.deps)).completed).toBe('R-1')
    expect(await workerOf(w.queue, 'R-1')).toBe('sma-executor-2')

    w.closed.delete('sma-executor')

    for (const n of [2, 3, 4]) expect((await tick(w.deps)).completed).toBe(`R-${n}`)

    const drivers = await Promise.all([1, 2, 3, 4].map((n) => workerOf(w.queue, `R-${n}`)))
    expect(drivers).toEqual(['sma-executor-2', 'sma-executor', 'sma-executor', 'sma-executor'])
  })

  it('закрепление ничего не решает за маршрут: выключенный работник сборку не держит', async () => {
    // «Предпочтение, а не замок» — сказано в коде, и вот случай, который это утверждает.
    // Держать сборку за счётом, которого нет, значило бы простой, которого никто не просил.
    const w = world({ closed: new Set(['sma-executor']) })
    await enqueueBatch(w.queue, 'B-2', [{}, {}])

    expect((await tick(w.deps)).completed).toBe('B-2-1')
    expect(await workerOf(w.queue, 'B-2-1')).toBe('sma-executor-2')

    // Работника сборки выключили между кусками, первого — вернули.
    w.closed.delete('sma-executor')
    w.deps.config.workers = [specialist('sma-ai-researcher'), executor('sma-executor'), { ...executor('sma-executor-2'), enabled: false }]

    expect((await tick(w.deps)).completed).toBe('B-2-2')
    expect(await workerOf(w.queue, 'B-2-2')).toBe('sma-executor')
  })
})

// ═════════ 2 · КРАСНЫЙ СЛУЧАЙ: ПОДМЕНА ИСПОЛНИТЕЛЯ НЕ БЫВАЕТ МОЛЧАЛИВОЙ ═══════════════════

describe('сборка, закреплённая за специалистом, расклеивается — и говорит об этом', () => {
  /**
   * ДВЕ СТОРОНЫ ОДНОГО ЗАПРЕТА, и обе здесь красные, если их сломать:
   *
   *   • отдать закрепление роли — и кусок, названный исполнительским, поедет под описанием
   *     исследователя; определение агента выдаётся сессии ТОЛЬКО через выбранного работника,
   *     так что это ровно та подмена, ради запрета которой роль стоит первой строкой фильтра;
   *   • оставить расклейку молчаливой — и «одна сборка — один работник» перестанет быть
   *     правилом, о нарушении которого хоть кто-то узнаёт.
   */
  it('кусок без слова о роли едет ИСПОЛНИТЕЛЮ, а расклейка названа словами в журнале', async () => {
    const w = world()
    await enqueueBatch(w.queue, 'B-3', [{ role: 'ai-researcher' }, {}])

    expect((await tick(w.deps)).completed).toBe('B-3-1')
    expect(await workerOf(w.queue, 'B-3-1')).toBe('sma-ai-researcher')

    expect((await tick(w.deps)).completed).toBe('B-3-2')
    const second = await workerOf(w.queue, 'B-3-2')

    // ПОДМЕНЫ НЕТ: работа, роли не назвавшая, ушла исполнителю, а не под чужое описание агента.
    expect(second).toBe('sma-executor')
    expect(second).not.toBe('sma-ai-researcher')

    // И МОЛЧАНИЯ ТОЖЕ НЕТ: ровно одна строка, и в ней названы сборка, обе роли и работник.
    const letGo = w.journalled.filter((e: any) => e.type === 'batch.pin_let_go')
    expect(letGo).toHaveLength(1)
    expect(letGo[0]).toMatchObject({
      taskId: 'B-3-2',
      batchId: 'B-3',
      workerId: 'sma-ai-researcher',
      reason: 'role_mismatch',
      role: 'executor',
      pinnedRole: 'ai-researcher',
    })
    expect(String(letGo[0].detail)).toContain('роль главнее закрепления')
  })

  it('сборка, у которой роль названа на КАЖДОМ куске, за специалистом держится и молчит', async () => {
    // Обратная сторона того же: когда роль совпадает, закрепление работает честно — и говорить
    // не о чем. Без этого случая предыдущий доказывал бы только то, что строка иногда пишется.
    const w = world()
    await enqueueBatch(w.queue, 'B-4', [{ role: 'ai-researcher' }, { role: 'ai-researcher' }, { role: 'ai-researcher' }])

    for (const n of [1, 2, 3]) expect((await tick(w.deps)).completed).toBe(`B-4-${n}`)

    const drivers = await Promise.all([1, 2, 3].map((n) => workerOf(w.queue, `B-4-${n}`)))
    expect(drivers).toEqual(['sma-ai-researcher', 'sma-ai-researcher', 'sma-ai-researcher'])
    expect(w.journalled.filter((e: any) => e.type === 'batch.pin_let_go')).toEqual([])
  })
})

// ═════════ 3 · САМ `poolFor` — ПРЯМЫМИ СЛУЧАЯМИ ═══════════════════════════════════════════

describe('poolFor — пул, каким его должен увидеть маршрут для ЭТОГО куска', () => {
  const listing = (rows: any[]) => ({ list: async () => rows })
  const piece = (over: Record<string, unknown> = {}) => ({ id: 'B-9-2', lane: 'prod', batchId: 'B-9', attempt: 1, ...over })
  const ran = (workerId: string) => ({ id: 'B-9-1', lane: 'prod', batchId: 'B-9', workerId })

  const deps = (rows: any[], workers = POOL) => {
    const journalled: any[] = []
    return { d: { adapter: listing(rows), config: { workers }, journal: (e: any) => journalled.push(e) }, journalled }
  }

  it('работа без сборки получает пул ровно как в конфиге, и слов о ней нет', async () => {
    const { d, journalled } = deps([])
    expect(await poolFor(d as any, { id: 'R-1', lane: 'prod' } as any)).toEqual(POOL)
    expect(journalled).toEqual([])
  })

  it('кусок сборки получает работника сборки ПЕРВЫМ, остальные — в прежнем порядке', async () => {
    const { d, journalled } = deps([ran('sma-executor-2')])
    const out: any[] = await poolFor(d as any, piece() as any)
    expect(out.map((w) => w.id)).toEqual(['sma-executor-2', 'sma-ai-researcher', 'sma-executor'])
    expect(journalled).toEqual([]) // закрепление работает — говорить не о чем
  })

  it('первый кусок сборки ещё никого не назвал — предпочитать некого, пул прежний', async () => {
    const { d, journalled } = deps([{ id: 'B-9-2', lane: 'prod', batchId: 'B-9', workerId: 'daemon-claimed' }])
    // Строка САМОГО куска исключается по имени: её `workerId` — это демон, взявший задачу до
    // выбора работника, и прочитать его как «работника сборки» значило бы ответить вопросом.
    expect(await poolFor(d as any, piece() as any)).toEqual(POOL)
    expect(journalled).toEqual([])
  })

  it('работник сборки исчез из конфига — закрепление отпущено, и причина названа', async () => {
    const { d, journalled } = deps([ran('sma-executor-7')])
    expect(await poolFor(d as any, piece() as any)).toEqual(POOL)
    expect(journalled).toHaveLength(1)
    expect(journalled[0]).toMatchObject({
      type: 'batch.pin_let_go',
      taskId: 'B-9-2',
      batchId: 'B-9',
      workerId: 'sma-executor-7',
      reason: 'not_in_pool',
    })
  })

  it('роль куска расходится с ролью работника сборки — отпущено, и обе роли названы', async () => {
    const { d, journalled } = deps([ran('sma-ai-researcher')])
    expect(await poolFor(d as any, piece() as any)).toEqual(POOL)
    expect(journalled[0]).toMatchObject({ reason: 'role_mismatch', role: 'executor', pinnedRole: 'ai-researcher' })
  })

  it('и наоборот: кусок просит специалиста, а сборка держится за исполнителем', async () => {
    const { d, journalled } = deps([ran('sma-executor')])
    expect(await poolFor(d as any, piece({ role: 'ai-researcher' }) as any)).toEqual(POOL)
    expect(journalled[0]).toMatchObject({ reason: 'role_mismatch', role: 'ai-researcher', pinnedRole: 'executor' })
  })

  it('очередь бросила — пул прежний, тик не гибнет, и падение записано', async () => {
    const journalled: any[] = []
    const d: any = {
      adapter: {
        list: async () => {
          throw new Error('очередь недоступна')
        },
      },
      config: { workers: POOL },
      journal: (e: any) => journalled.push(e),
    }
    expect(await poolFor(d, piece() as any)).toEqual(POOL)
    expect(journalled[0]).toMatchObject({ type: 'batch.pin_unreadable', taskId: 'B-9-2' })
    expect(String(journalled[0].error)).toContain('очередь недоступна')
  })

  it('конфиг без работников — пустой пул, а не падение', async () => {
    const { d } = deps([ran('sma-executor')], undefined as any)
    expect(await poolFor({ ...(d as any), config: {} } as any, piece() as any)).toEqual([])
  })
})
