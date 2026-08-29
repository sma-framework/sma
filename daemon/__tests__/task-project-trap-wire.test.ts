/**
 * ЛОВУШКА АКТИВНОГО ПРОЕКТА: задача уезжает в дерево, где нужного кода нет.
 *
 * ════════════════════ ЧТО ЭТО ЗА ДЕФЕКТ И ЧЕГО ОН СТОИЛ ════════════════════════
 * Штамп проекта ставится ПРИ СОЗДАНИИ задачи (`doorProject`) и переключением активного
 * проекта задним числом не чинится — иначе принадлежность работы снова поехала бы за
 * взглядом человека. Замерено 28.08: шесть работ поставлены при активном проекте мастерской;
 * работник получил копию дерева ПЛАНИРОВАНИЯ, не нашёл в ней исходников демона, упёрся в
 * стража «запись за пределы рабочей копии» и вернулся с вопросом. Чинить пришлось отменой и
 * пересозданием всех шести.
 *
 * У ловушки три половины, и здесь каждая проверяется своим проводом:
 *   1. КУДА УЕДЕТ — дверь постановки называет проект В ОТВЕТЕ, а дверь предложения слов
 *      называет его ДО постановки, вместе с текстом человека на руках;
 *   2. ЧЕГО ТАМ НЕТ — та же дверь предложения отвечает, каких НАЗВАННЫХ в задаче путей в
 *      выбранном дереве не существует (и молчит, когда проверять нечего);
 *   3. ОШИБКА ДЕШЁВАЯ — созданную не в том проекте задачу ПЕРЕСТАВЛЯЮТ, и провод дотянут до
 *      конца: следующая выдача отводит копию уже из ДРУГОГО дерева.
 *
 * Третий случай — настоящий wire-тест и главный здесь: дверь, очередь и тик проверяются
 * вместе, потому что каждый из трёх был бы зелёным поодиночке ровно в том мире, где
 * перестановка ничего не меняет для работника.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { join } from 'node:path'

import { createFrontServer } from '../src/front/server.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { namedPaths, missingPaths, NAMED_PATH_CAP } from '../src/front/tree-probe.mjs'
import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

const TOKEN = 'p'.repeat(64)
const NOW = 1_700_000_000_000

const WORKSHOP = { id: 'workshop', name: 'Мастерская', path: join('/trees', 'workshop') }
const PRODUCT = { id: 'product', name: 'Продукт', path: join('/trees', 'product') }

function mkReq(url: string, body?: unknown) {
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
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      return res
    },
  }
  return res
}

async function post(front: any, url: string, body: unknown) {
  const res = mkRes()
  await front.handle(mkReq(url, body), res)
  return res
}

/** Конфиг с ДВУМЯ деревьями — тот самый случай, в котором ловушка и живёт. */
function twoTreeConfig(over: any = {}) {
  return {
    token: TOKEN,
    workers: [{ id: 'w-1', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
    projects: [WORKSHOP, PRODUCT],
    activeProject: WORKSHOP.id,
    repoDir: '/repo',
    agingHours: 24,
    backlogScanMinutes: 60,
    pipeline: { enabled: true },
    ...over,
  }
}

/** Шов существования, отвечающий по СПИСКУ путей — ни одного обращения к диску. */
const treeWith = (present: string[]) => (full: string) => present.some((p) => String(full).endsWith(p))

// ═════════════════════ 1 · КУДА ЗАДАЧА УЕДЕТ, СКАЗАНО ДВЕРЬЮ ══════════════════════

describe('дверь постановки возвращает проект, в который задача уехала', () => {
  it('ответ /api/enqueue называет штамп, который дверь реально записала на строку', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    const front = createFrontServer({ config: twoTreeConfig(), deps: { adapter, clock: () => NOW } })

    const res = await post(front, '/api/enqueue', { title: 'починить импорт', lane: 'prod' })

    expect(res.statusCode).toBe(200)
    const answer = JSON.parse(res.body)
    expect(answer.ok).toBe(true)
    expect(answer.project).toBe(WORKSHOP.id)
    // и это ровно то, что легло в очередь — ответ говорит о СТРОКЕ, а не о намерении двери
    const [row] = await adapter.list({})
    expect(row.project).toBe(WORKSHOP.id)
  })

  it('демон без выбранного проекта отвечает `null`, а не выдуманным именем', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    const config = twoTreeConfig({ activeProject: null })
    const front = createFrontServer({ config, deps: { adapter, clock: () => NOW } })

    const answer = JSON.parse((await post(front, '/api/enqueue', { title: 'работа', lane: 'prod' })).body)

    expect(answer.project).toBeNull()
    expect((await adapter.list({}))[0].project).toBeNull()
  })
})

describe('дверь предложения слов называет проект ДО постановки — и молчит о том, чего не проверяла', () => {
  const mk = (over: any = {}) =>
    createFrontServer({
      config: twoTreeConfig(over.config),
      deps: { adapter: createMemoryQueue({ clock: () => NOW }), clock: () => NOW, ...over.deps },
    })

  it('имя проекта приходит вместе с черновиком — человеку есть что прочесть до нажатия', async () => {
    const front = mk({ deps: { fsImpl: { existsSync: () => true } } })

    const answer = JSON.parse((await post(front, '/api/task/suggest', { title: 'Почини импорт агентов' })).body)

    expect(answer.project).toEqual({ id: WORKSHOP.id, name: WORKSHOP.name })
    expect(answer.draft.description).toBe('Почини импорт агентов') // прежний ответ не тронут
  })

  it('проект, которого нет в реестре, называет сам себя — а не красивое выдуманное имя', async () => {
    const front = mk({ config: { activeProject: 'ушедший' }, deps: { fsImpl: { existsSync: () => true } } })

    const answer = JSON.parse((await post(front, '/api/task/suggest', { title: 'работа' })).body)

    expect(answer.project).toEqual({ id: 'ушедший', name: 'ушедший' })
    expect(answer.missing).toEqual([]) // дерева не назвали — проверять было нечего
  })

  it('на демоне без выбранного проекта проект `null`, и предупреждения нет', async () => {
    const front = mk({ config: { activeProject: null } })

    const answer = JSON.parse((await post(front, '/api/task/suggest', { title: 'работа' })).body)

    expect(answer.project).toBeNull()
    expect(answer.missing).toEqual([])
  })
})

// ═════════════ 2 · ПРЕДУПРЕЖДЕНИЕ: ЭТОГО В ВЫБРАННОМ ДЕРЕВЕ НЕТ ═══════════════════

describe('предупреждение появляется, когда дерево проекта не содержит названного в задаче', () => {
  const withTree = (present: string[]) =>
    createFrontServer({
      config: twoTreeConfig(),
      deps: {
        adapter: createMemoryQueue({ clock: () => NOW }),
        clock: () => NOW,
        fsImpl: { existsSync: treeWith(present) },
      },
    })

  it('задача говорит о файлах, которых в выбранном дереве нет, — дверь их называет', async () => {
    const front = withTree([join('.planning', 'PLAN.md')]) // дерево планирования: исходников в нём нет

    const answer = JSON.parse(
      (await post(front, '/api/task/suggest', { title: 'Почини daemon/src/front/server.mjs и spa/src/api/client.ts' }))
        .body,
    )

    expect(answer.missing).toEqual(['daemon/src/front/server.mjs', 'spa/src/api/client.ts'])
    expect(answer.project).toEqual({ id: WORKSHOP.id, name: WORKSHOP.name })
  })

  it('те же слова о дереве, где эти файлы ЕСТЬ, предупреждения не поднимают', async () => {
    const front = withTree([join('daemon', 'src', 'front', 'server.mjs'), join('spa', 'src', 'api', 'client.ts')])

    const answer = JSON.parse(
      (await post(front, '/api/task/suggest', { title: 'Почини daemon/src/front/server.mjs и spa/src/api/client.ts' }))
        .body,
    )

    expect(answer.missing).toEqual([])
  })

  it('обычная фраза без путей не проверяется вовсе — предупреждение не выдумывается из прозы', async () => {
    const front = withTree([]) // в дереве нет НИЧЕГО, и всё равно сказать нечего

    const answer = JSON.parse(
      (await post(front, '/api/task/suggest', { title: 'Разберись, почему окно показывает пустую очередь' })).body,
    )

    expect(answer.missing).toEqual([])
  })

  it('дверь предложения по-прежнему НИЧЕГО НЕ СТАВИТ: очередь после предупреждения пуста', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    const front = createFrontServer({
      config: twoTreeConfig(),
      deps: { adapter, clock: () => NOW, fsImpl: { existsSync: () => false } },
    })

    await post(front, '/api/task/suggest', { title: 'Почини daemon/src/front/server.mjs' })

    expect(await adapter.list({})).toHaveLength(0)
    expect((await adapter.stats()).total).toBe(0)
  })
})

describe('правило «что считать путём» проверяется без единого файла на диске', () => {
  it('путь берётся, когда человек написал его путём: с расширением или глубже одного слэша', () => {
    expect(namedPaths('правь daemon/src/front/server.mjs, потом spa/src/screens')).toEqual([
      'daemon/src/front/server.mjs',
      'spa/src/screens',
    ])
  })

  it('проза со слэшем путём не становится — иначе предупреждение врало бы чаще, чем помогало', () => {
    expect(namedPaths('сдал/не сдал, and/or, 24/7 и вообще и/или')).toEqual([])
  })

  it('адрес в сети — не путь в дереве', () => {
    expect(namedPaths('см. https://example.com/docs/guide.md')).toEqual([])
  })

  it('абсолютное и выход наверх не проверяются: это не «внутри проекта»', () => {
    expect(namedPaths('/etc/passwd и ../../secrets/key.pem и C:/Windows/system32')).toEqual([])
  })

  it('список ограничен сверху — предупреждение из двадцати строк никто не читает', () => {
    const many = Array.from({ length: NAMED_PATH_CAP + 4 }, (_, i) => `a/b/c${i}.ts`).join(' ')
    expect(namedPaths(many)).toHaveLength(NAMED_PATH_CAP)
  })

  it('шов, который бросил, читается как «не знаю» — а не как «этого нет»', () => {
    const missing = missingPaths({
      paths: ['a/b/c.ts'],
      projectDir: '/tree',
      existsImpl: () => {
        throw new Error('нет доступа')
      },
    })
    expect(missing).toEqual([])
  })

  it('дерева не назвали — проверять нечего, и это не пустой ответ «всё на месте»', () => {
    expect(missingPaths({ paths: ['a/b/c.ts'], projectDir: '', existsImpl: () => false })).toEqual([])
  })
})

// ═════════════ 3 · ОШИБКА ДЕШЁВАЯ: ЗАДАЧУ ПЕРЕСТАВЛЯЮТ, А НЕ ПЕРЕСОЗДАЮТ ══════════

describe('созданную не в том проекте задачу ПЕРЕСТАВЛЯЮТ', () => {
  const mkFront = (adapter: any, config = twoTreeConfig()) =>
    createFrontServer({ config, deps: { adapter, clock: () => NOW } })

  const live = (adapter: any) =>
    adapter.enqueue({ id: 'R-1', source: 'roster', title: 'починить импорт', lane: 'prod', project: WORKSHOP.id })

  it('дверь слов переставляет живую задачу и называет новый проект в ответе', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    await live(adapter)
    const front = mkFront(adapter)

    const res = await post(front, '/api/task/words', { taskId: 'R-1', project: PRODUCT.id })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).project).toBe(PRODUCT.id)
    const [row] = await adapter.list({})
    expect(row.project).toBe(PRODUCT.id)
    expect(row.title).toBe('починить импорт') // переставили задачу, а не переписали её
  })

  it('правка слов, не назвавшая проекта, его не трогает и о нём не заявляет', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    await live(adapter)
    const front = mkFront(adapter)

    const res = await post(front, '/api/task/words', { taskId: 'R-1', description: 'вторая редакция' })

    expect(JSON.parse(res.body).project).toBeUndefined()
    expect((await adapter.list({}))[0].project).toBe(WORKSHOP.id)
  })

  it('проект, которого эта машина не знает, — отказ ДО очереди, и строка не тронута', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    await live(adapter)
    const front = mkFront(adapter)

    const res = await post(front, '/api/task/words', { taskId: 'R-1', project: 'чужое-дерево' })

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('no such project')
    expect((await adapter.list({}))[0].project).toBe(WORKSHOP.id)
  })

  it('задачу, чья работа кончилась, не переставляют: дерево, в котором она шла, переписывать нечем', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    await live(adapter)
    await adapter.claimNext('w-1', {})
    await adapter.complete('R-1', { receiptRef: 'reverify:abc' })
    const front = mkFront(adapter)

    const res = await post(front, '/api/task/words', { taskId: 'R-1', project: PRODUCT.id })

    expect(res.statusCode).toBe(409)
    expect((await adapter.list({}))[0].project).toBe(WORKSHOP.id)
  })
})

// ═════════════ ПРОВОД ЦЕЛИКОМ: ПЕРЕСТАНОВКА МЕНЯЕТ ДЕРЕВО, ИЗ КОТОРОГО ОТВОДЯТ КОПИЮ ══

/**
 * Раннер, записывающий КАТАЛОГ каждого вызова верба. Именно cwd провизии и есть ответ на
 * вопрос «из какого дерева работнику отвели копию» — путь копии верб получает флагом, а
 * репозиторий, в котором эта копия режется, он берёт из каталога вызова.
 */
function cwdRecordingRunner() {
  const provisions: { cwd: string | undefined; args: string[] }[] = []
  const runner = async (_bin: string, argsArray: string[], opts: any = {}) => {
    const verb = argsArray[1]
    const sub = argsArray[2]
    if (verb === 'worktree' && sub === 'provision') {
      provisions.push({ cwd: opts?.cwd, args: argsArray })
      const p = argsArray.indexOf('--path')
      const b = argsArray.indexOf('--branch')
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          path: p >= 0 ? argsArray[p + 1] : '/wt/x',
          branch: b >= 0 ? argsArray[b + 1] : null,
          expectedBase: 'a'.repeat(40),
        }),
      }
    }
    if (verb === 'worktree') return { code: 0, stdout: JSON.stringify({ worktrees: [] }) }
    if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
    return { code: 0, stdout: '{}' }
  }
  return { runner, provisions }
}

function loopDeps(adapter: any, config: any, runner: any) {
  return {
    adapter,
    config,
    ledger: { recordAttempt: (a: any) => a, readAttempts: () => [] },
    routing: { resolveRoute },
    windows: () => true,
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
    verbRunner: runner,
    spawnWorker: (spec: any) => {
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 1, kill: () => {} }
    },
    report: async () => {},
    clock: () => NOW,
    journal: () => {},
  }
}

describe('ПРОВОД: перестановка проекта у СОЗДАННОЙ задачи меняет дерево, из которого отводится копия', () => {
  it('без перестановки копия режется в дереве, которое штампанула дверь', async () => {
    const config = twoTreeConfig()
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const front = createFrontServer({ config, deps: { adapter, clock: () => NOW } })
    await post(front, '/api/enqueue', { title: 'работа', lane: 'prod' })

    const rec = cwdRecordingRunner()
    await tick(loopDeps(adapter, config, rec.runner))

    expect(rec.provisions, 'копию не отводили вовсе').toHaveLength(1)
    expect(rec.provisions[0].cwd).toBe(WORKSHOP.path)
  })

  it('после перестановки — В ДРУГОМ, и это тот самый провод, ради которого перестановка есть', async () => {
    const config = twoTreeConfig()
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const front = createFrontServer({ config, deps: { adapter, clock: () => NOW } })
    const id = JSON.parse((await post(front, '/api/enqueue', { title: 'работа', lane: 'prod' })).body).id

    // человек увидел, что задача уехала не туда, и ПЕРЕСТАВИЛ её — не отменяя и не пересоздавая
    expect((await post(front, '/api/task/words', { taskId: id, project: PRODUCT.id })).statusCode).toBe(200)

    const rec = cwdRecordingRunner()
    await tick(loopDeps(adapter, config, rec.runner))

    expect(rec.provisions, 'копию не отводили вовсе').toHaveLength(1)
    expect(rec.provisions[0].cwd, 'копию отвели из старого дерева — перестановка до работника не доехала').toBe(
      PRODUCT.path,
    )
  })

  it('активный проект при этом НЕ трогали: перестановка — свойство задачи, а не взгляда', async () => {
    const config = twoTreeConfig()
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const front = createFrontServer({ config, deps: { adapter, clock: () => NOW } })
    const id = JSON.parse((await post(front, '/api/enqueue', { title: 'работа', lane: 'prod' })).body).id

    await post(front, '/api/task/words', { taskId: id, project: PRODUCT.id })

    expect(config.activeProject).toBe(WORKSHOP.id)
  })
})
