/**
 * У ПРОЕКТА ДВА АДРЕСА: ДЕРЕВО КОДА И ДОМ ПЛАНИРОВАНИЯ.
 *
 * ═══════════════════ ЧТО ЭТО ЗА ДЕФЕКТ И ЧЕГО ОН СТОИЛ ══════════════════════════
 * Закон дома разводит код и планирование по РАЗНЫМ репозиториям, а запись реестра знала
 * РОВНО ОДИН адрес `{id, name, path}` и читала планирование как `<path>/.planning`. Дом
 * планирования приходилось заводить ВТОРЫМ ПРОЕКТОМ — и отсюда вся путаница: в одном проекте
 * видны задачи, в другом фазы и беклог; выключить лишний нельзя, иначе фазы и беклог не
 * переедут, а ИСЧЕЗНУТ.
 *
 * ЗАМЕРЕНО ТРИЖДЫ ЗА НОЧЬ 31.08.2026, и каждый замер здесь свой провод:
 *   1. сканер беклога молчал — читал беклог по адресу дерева кода, где `.planning` нет;
 *   2. ступень plan фазы 21 получила копию ПРОДУКТА, где каталогов фаз нет, ушла искать фазу
 *      по машине, нашла ЧУЖУЮ фазу 21 соседнего проекта и честно отказалась — восемнадцать
 *      ходов и около доллара за отказ, который можно составить у двери бесплатно;
 *   3. приёмка готовой работы продукта при подключённой мастерской вернула `branch_missing`,
 *      хотя ветка была на месте: git спрашивали не в том дереве.
 *
 * ЧИНИТСЯ НЕ «КАКОЕ ДЕРЕВО У ЗАДАЧИ», А САМО ПОНЯТИЕ ПРОЕКТА: у записи появляется ВТОРОЙ,
 * НЕОБЯЗАТЕЛЬНЫЙ адрес. Не задан — всё работает ровно как раньше, и это тоже проверяется
 * здесь: половина случаев ниже стоит ради «ничего не изменилось».
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  validateProject,
  addProject,
  setProjectPlanning,
  planningHomeOf,
  codeTreeOf,
  projectEntry,
} from '../src/config.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { deriveBacklog } from '../src/front/state.mjs'
import { createDaemon } from '../src/main.mjs'
import { tick } from '../src/loop.mjs'

const TOKEN = 'p'.repeat(64)
const NOW = 1_700_000_000_000

const PRODUCT = { id: 'product', name: 'Продукт', path: join('/trees', 'product') }
const WORKSHOP = { id: 'workshop', name: 'Мастерская', path: join('/trees', 'workshop') }
/** ОДИН проект с двумя адресами — то, ради чего всё это написано. */
const TWO_ADDRESS = { id: 'product', name: 'Продукт', path: join('/trees', 'product'), planningPath: join('/trees', 'workshop') }

function mkReq(method: string, url: string, body?: unknown) {
  const req: any = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
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

async function post(front: any, url: string, body?: unknown) {
  const res = mkRes()
  await front.handle(mkReq('POST', url, body), res)
  return res
}

// ═══════════════ 1 · РЕЕСТР: ВТОРОЙ АДРЕС ЕСТЬ И ОН НЕОБЯЗАТЕЛЕН ═══════════════════

describe('запись проекта носит два адреса, и второй можно не называть', () => {
  it('без второго адреса дом планирования — это дерево кода, буква в букву', () => {
    const entry = validateProject({ id: 'p', name: 'П', path: '/trees/p' })
    expect(entry.planningPath).toBeUndefined()
    expect(codeTreeOf(entry)).toBe('/trees/p')
    expect(planningHomeOf(entry)).toBe('/trees/p')
  })

  it('со вторым адресом дерево кода НЕ ДВИГАЕТСЯ — это не переезд, а второй адрес', () => {
    const entry = validateProject(TWO_ADDRESS)
    expect(codeTreeOf(entry)).toBe(TWO_ADDRESS.path)
    expect(planningHomeOf(entry)).toBe(TWO_ADDRESS.planningPath)
  })

  it('пустая строка на месте адреса — ошибка, а не «адреса нет»', () => {
    expect(() => validateProject({ id: 'p', name: 'П', path: '/trees/p', planningPath: '  ' })).toThrow(/planningPath/)
  })

  it('`null` — это отсутствие, и ключа в записи не остаётся вовсе', () => {
    const entry = validateProject({ id: 'p', name: 'П', planningPath: null })
    expect('planningPath' in entry).toBe(false)
  })

  it('дверь реестра заводит проект сразу с обоими адресами — второй проект не нужен', () => {
    const writes: any[] = []
    const io = { fsImpl: {}, env: {}, homedir: () => '/home', launchDir: '/launch' }
    const next = addProject(
      { projects: [], activeProject: null },
      { name: 'Продукт', path: '/trees/product', planningPath: '/trees/workshop' },
      { ...io, fsImpl: { writeFileSync: (...a: any[]) => writes.push(a), mkdirSync() {}, renameSync() {}, readFileSync: () => '{}' } } as any,
    )
    expect(next.projects).toHaveLength(1)
    expect(planningHomeOf(next.projects[0])).toBe('/trees/workshop')
    expect(codeTreeOf(next.projects[0])).toBe('/trees/product')
  })

  it('дверь второго адреса ставит и СНИМАЕТ его, не трогая дерево кода', () => {
    const fsImpl = { writeFileSync() {}, mkdirSync() {}, renameSync() {}, readFileSync: () => '{}' } as any
    const io = { env: {}, homedir: () => '/home', launchDir: '/launch', fsImpl }
    const base = { projects: [{ id: 'product', name: 'Продукт', path: '/trees/product' }], activeProject: 'product' }

    const set = setProjectPlanning(base, { id: 'product', planningPath: '/trees/workshop' }, io as any)
    expect(planningHomeOf(projectEntry(set, 'product'))).toBe('/trees/workshop')
    expect(codeTreeOf(projectEntry(set, 'product'))).toBe('/trees/product')

    const cleared = setProjectPlanning(set, { id: 'product', planningPath: null }, io as any)
    expect(planningHomeOf(projectEntry(cleared, 'product'))).toBe('/trees/product')
    expect(codeTreeOf(projectEntry(cleared, 'product'))).toBe('/trees/product')
  })

  it('проект, которого эта машина не знает, — названный отказ, а не тихая запись', () => {
    const fsImpl = { writeFileSync() {}, mkdirSync() {}, renameSync() {}, readFileSync: () => '{}' } as any
    expect(() =>
      setProjectPlanning({ projects: [] }, { id: 'нет-такого', planningPath: '/x' }, { env: {}, homedir: () => '/h', fsImpl } as any),
    ).toThrow(/unknown project/)
  })
})

// ═══════════ 2 · БЕКЛОГ ЧИТАЕТСЯ ИЗ ДОМА ПЛАНИРОВАНИЯ, А НЕ ИЗ ДЕРЕВА КОДА ══════════

describe('беклог одного проекта, чей дом планирования в другом каталоге', () => {
  const BACKLOG = ['## Backlog', '', '- [ ] **BL-007** · Починить импорт — почему `sp:3`', ''].join('\n')

  /** Шов, у которого файл беклога лежит ровно по ОДНОМУ пути и больше нигде. */
  const treeWithBacklogAt = (where: string) => ({
    readFileSync: (full: string) => {
      if (String(full) === join(where, '.planning', 'BACKLOG.md')) return BACKLOG
      throw new Error('ENOENT')
    },
  })

  it('беклог виден при ОДНОМ проекте, чей .planning лежит в мастерской', () => {
    const out = deriveBacklog({
      config: { projects: [TWO_ADDRESS], activeProject: TWO_ADDRESS.id },
      fsImpl: treeWithBacklogAt(TWO_ADDRESS.planningPath),
    })
    expect(out.rows.map((r: any) => r.id)).toEqual(['BL-007'])
  })

  it('без второго адреса читается дерево кода — прежнее поведение не тронуто', () => {
    const out = deriveBacklog({
      config: { projects: [PRODUCT], activeProject: PRODUCT.id },
      fsImpl: treeWithBacklogAt(PRODUCT.path),
    })
    expect(out.rows.map((r: any) => r.id)).toEqual(['BL-007'])
  })

  it('файла нет ни по одному из адресов — пустой список, а не поломка', () => {
    const out = deriveBacklog({
      config: { projects: [TWO_ADDRESS], activeProject: TWO_ADDRESS.id },
      fsImpl: treeWithBacklogAt('/trees/nowhere'),
    })
    expect(out.rows).toEqual([])
  })
})

// ═════ 3 · ПРОВОД ЦЕЛИКОМ: ОДИН ПРОЕКТ, ДВА КАТАЛОГА, НАСТОЯЩИЙ КОРЕНЬ ═══════════
//
// Ни одна часть по отдельности этого не видит: реестр знает свои записи, проекция читает
// каталог, который ей дали, дверь просит каталог. Ошибка живёт РОВНО в месте склейки —
// поэтому здесь поднимается production-корень над двумя настоящими папками на диске.

describe('ПРОВОД: двухрепный дом настраивается ОДНИМ проектом', () => {
  const PHASE_DIR = '21-the-workshop-phase'
  const CODE_PHASE_DIR = '01-the-code-tree-phase'

  let root: string
  let product: string
  let workshop: string
  let park: any
  let savedConfigEnv: string | undefined

  const call = async (method: string, url: string, body?: any) => {
    const res = mkRes()
    await park.front.handle(mkReq(method, url, body), res)
    return res
  }

  const seedPhase = (tree: string, phaseDir: string) => {
    const dir = join(tree, '.planning', 'phases', phaseDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${phaseDir.slice(0, 2)}-01-PLAN.md`), '# план, чтобы фаза была настоящей строкой\n', 'utf8')
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sma-two-address-'))
    product = join(root, 'product')
    workshop = join(root, 'workshop')
    // ДВЕ ПАПКИ, В КАЖДОЙ СВОЯ ФАЗА. Проверять путь бессмысленно: дефект отвечает существующим
    // каталогом, просто НЕ ТЕМ, — поэтому фикстуры различаются тем, что дверь может НАЗВАТЬ.
    seedPhase(workshop, PHASE_DIR)
    seedPhase(product, CODE_PHASE_DIR)
    mkdirSync(join(product, '.claude', 'memory'), { recursive: true })
    writeFileSync(
      join(workshop, '.planning', 'BACKLOG.md'),
      ['## Backlog', '', '- [ ] **BL-101** · Работа из мастерской — `sp:3` почему', ''].join('\n'),
      'utf8',
    )

    const configPath = join(root, 'daemon-config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        queueUrl: 'postgres://127.0.0.1:1/sma_none',
        bind: '127.0.0.1',
        port: 7997,
        token: TOKEN,
        repoDir: join(root, 'served'),
        dataDir: join(root, 'data'),
        ledgerDir: join(root, 'ledger'),
        // ОДИН проект. Мастерская — его ВТОРОЙ адрес, а не вторая запись реестра.
        projects: [{ id: 'product', name: 'Продукт', path: product, planningPath: workshop }],
        activeProject: 'product',
        workers: [
          {
            id: 'max-1',
            lane: 'prod',
            provider: 'claude',
            enabled: true,
            account: { name: 'max-1', configDir: join(root, 'accounts', 'max-1') },
          },
        ],
      }),
      'utf8',
    )
    savedConfigEnv = process.env.SMA_DAEMON_CONFIG
    process.env.SMA_DAEMON_CONFIG = configPath
    park = createDaemon()
  })

  afterAll(async () => {
    try {
      await park.stop()
    } catch {
      /* ничего не запускалось — остановка вправе отказать */
    }
    if (savedConfigEnv === undefined) delete process.env.SMA_DAEMON_CONFIG
    else process.env.SMA_DAEMON_CONFIG = savedConfigEnv
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('в реестре ОДИН проект — второй заводить не пришлось, и в окне его нет', async () => {
    const res = await call('GET', '/api/projects')
    expect(res.statusCode, res.body).toBe(200)
    const payload = JSON.parse(res.body)
    expect(payload.projects.map((p: any) => p.id)).toEqual(['product'])
    expect(payload.activeProject).toBe('product')
  })

  it('фазы приходят из ДОМА ПЛАНИРОВАНИЯ, а не из дерева кода', async () => {
    const res = await call('GET', '/api/phase/index')
    expect(res.statusCode, res.body).toBe(200)
    const ids = JSON.parse(res.body).phases.map((p: any) => p.id)
    expect(ids).toEqual([PHASE_DIR])
    expect(ids).not.toContain(CODE_PHASE_DIR)
  })

  it('сканер беклога читает беклог ДОМА ПЛАНИРОВАНИЯ — молчание кончилось', async () => {
    const scan = await park.tickDeps.intake.scan()
    expect(scan.items.map((t: any) => t.id)).toEqual(['BL-101'])
  })

  it('два каталога названы двумя выражениями и не смешиваются', () => {
    expect(park.front.deps.phaseCycleDir()).toBe(workshop)
    expect(park.front.deps.codeTreeDir()).toBe(product)
    // код по-прежнему строится в дереве кода: тик отводит копию оттуда
    expect(park.tickDeps.projectDir()).toBe(product)
    expect(park.tickDeps.planningDir()).toBe(workshop)
  })
})

// ═══════════ 4 · ПРИЁМКА ИЩЕТ ВЕТКУ В ДЕРЕВЕ ЗАДАЧИ, А НЕ В ВЫБРАННОМ ═══════════

describe('приёмка задачи проекта A при подключённом B', () => {
  /** Приёмка требует CAS-перехода; здесь он всегда выигрывается — под проверкой не он. */
  const casExec = async (sql: string) => {
    if (/update/i.test(sql)) return { rowCount: 1, rows: [{ id: 'R-1' }] }
    return { rowCount: 0, rows: [] }
  }

  const mkFront = (over: any = {}) => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    const seen: any[] = []
    const front = createFrontServer({
      config: {
        token: TOKEN,
        workers: [{ id: 'w-1', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
        projects: over.projects ?? [PRODUCT, WORKSHOP],
        activeProject: over.activeProject ?? WORKSHOP.id,
        repoDir: '/repo',
        agingHours: 24,
        backlogScanMinutes: 60,
        pipeline: { enabled: true },
      },
      deps: {
        adapter,
        clock: () => NOW,
        casExec,
        ledger: { readAttempts: () => [{ attempt: 1, branch: 'wt/R-1' }] },
        verbRunner: async (o: any) => {
          seen.push(o)
          return { merged: true, testsPassed: true }
        },
        // окно смотрит на МАСТЕРСКУЮ — ровно тот случай, в котором приёмка ломалась
        phaseCycleDir: () => WORKSHOP.path,
        codeTreeDir: () => WORKSHOP.path,
        repoDir: '/repo',
      },
    })
    return { front, adapter, seen }
  }

  it('ветку ищут в дереве ПРОДУКТА, хотя в окне выбрана мастерская', async () => {
    const { front, adapter, seen } = mkFront()
    await adapter.enqueue({ id: 'R-1', source: 'roster', title: 'работа продукта', lane: 'prod', project: PRODUCT.id })

    const res = await post(front, '/api/approve', { taskId: 'R-1' })

    expect(res.statusCode, res.body).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
    expect(seen, 'слияния не звали вовсе').toHaveLength(1)
    expect(seen[0].cwd, 'ветку искали в дереве, выбранном в окне').toBe(PRODUCT.path)
    expect(seen[0].branch).toBe('wt/R-1')
  })

  it('копию убирают в том же дереве — иначе она осталась бы лежать навсегда', async () => {
    const cleanups: any[] = []
    const adapter = createMemoryQueue({ clock: () => NOW })
    const front = createFrontServer({
      config: {
        token: TOKEN,
        workers: [{ id: 'w-1', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
        projects: [PRODUCT, WORKSHOP],
        activeProject: WORKSHOP.id,
        repoDir: '/repo',
        agingHours: 24,
        backlogScanMinutes: 60,
        pipeline: { enabled: true },
      },
      deps: {
        adapter,
        clock: () => NOW,
        casExec,
        ledger: { readAttempts: () => [{ attempt: 1, branch: 'wt/R-2' }] },
        verbRunner: async () => ({ merged: true, testsPassed: true }),
        worktreeCleanup: async (a: any) => {
          cleanups.push(a)
          return { removed: true }
        },
        phaseCycleDir: () => WORKSHOP.path,
      },
    })
    await adapter.enqueue({ id: 'R-2', source: 'roster', title: 'работа продукта', lane: 'prod', project: PRODUCT.id })

    await post(front, '/api/approve', { taskId: 'R-2' })

    expect(cleanups).toHaveLength(1)
    expect(cleanups[0].cwd).toBe(PRODUCT.path)
  })

  it('строка без штампа проекта следует за окном — прежнее поведение не тронуто', async () => {
    const { front, adapter, seen } = mkFront()
    await adapter.enqueue({ id: 'R-1', source: 'roster', title: 'работа ничья', lane: 'prod' })

    await post(front, '/api/approve', { taskId: 'R-1' })

    expect(seen[0].cwd).toBe(WORKSHOP.path)
  })

  it('документарную ступень принимают в ДОМЕ ПЛАНИРОВАНИЯ её проекта', async () => {
    const { front, adapter, seen } = mkFront({ projects: [TWO_ADDRESS], activeProject: TWO_ADDRESS.id })
    await adapter.enqueue({
      id: 'R-1',
      source: 'roster',
      title: '/sma-plan-phase 21 --text --skip-research',
      lane: 'paperwork',
      project: TWO_ADDRESS.id,
      data: { kind: 'document', stage: 'plan', phase: '21' },
    })

    await post(front, '/api/approve', { taskId: 'R-1' })

    expect(seen[0].cwd).toBe(TWO_ADDRESS.planningPath)
  })
})

// ═══════ 5 · СТУПЕНЬ ФАЗЫ: ОТКАЗ ДО РАСХОДА И КОПИЯ ИЗ ДОМА ПЛАНИРОВАНИЯ ═══════

describe('ступень фазы ставится туда, где эта фаза живёт, — или не ставится вовсе', () => {
  /** Проекция карточки, отвечающая ТОЛЬКО про названный каталог: диск не участвует. */
  const cardOnlyIn = (where: string, phaseId: string) => (a: any) =>
    String(a.projectDir) === where && String(a.phaseId) === phaseId ? { id: phaseId, stages: {} } : null

  const mkFront = (over: any = {}) => {
    const adapter = createMemoryQueue({ clock: () => NOW })
    const front = createFrontServer({
      config: {
        token: TOKEN,
        workers: [{ id: 'w-1', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
        projects: over.projects ?? [TWO_ADDRESS],
        activeProject: over.activeProject ?? TWO_ADDRESS.id,
        repoDir: '/repo',
        agingHours: 24,
        backlogScanMinutes: 60,
        pipeline: { enabled: true },
      },
      deps: {
        adapter,
        clock: () => NOW,
        phaseCycleDir: () => over.phaseCycleDir ?? TWO_ADDRESS.path,
        ...(over.deps ?? {}),
      },
    })
    return { front, adapter }
  }

  it('фаза лежит в доме планирования — ступень ставится', async () => {
    const { front, adapter } = mkFront({ deps: { derivePhaseCard: cardOnlyIn(TWO_ADDRESS.planningPath, '21') } })

    const res = await post(front, '/api/phase/stage', { phase: '21', stage: 'plan' })

    expect(res.statusCode, res.body).toBe(200)
    expect(await adapter.list({})).toHaveLength(1)
  })

  it('фазы в доме планирования нет — ОТКАЗ ДО РАСХОДА, и очередь осталась пустой', async () => {
    const { front, adapter } = mkFront({ deps: { derivePhaseCard: cardOnlyIn('/trees/somebody-else', '21') } })

    const res = await post(front, '/api/phase/stage', { phase: '21', stage: 'plan' })

    expect(res.statusCode).toBe(409)
    // отказ НАЗЫВАЕТ адрес словами: чего не хватает и у какого проекта
    expect(res.body).toMatch(/дом.*планирован/i)
    expect(res.body).toMatch(/Продукт/)
    expect(await adapter.list({}), 'ступень всё-таки поставили — доллар сгорит снова').toHaveLength(0)
  })

  it('второй адрес не задан — смотрят в дерево кода, и отказ говорит именно это', async () => {
    const { front } = mkFront({
      projects: [PRODUCT],
      activeProject: PRODUCT.id,
      deps: { derivePhaseCard: cardOnlyIn('/trees/somebody-else', '21') },
    })

    const res = await post(front, '/api/phase/stage', { phase: '21', stage: 'plan' })

    expect(res.statusCode).toBe(409)
    expect(res.body).toMatch(/второй адрес/i)
  })

  it('проверять нечем — прежнее поведение: дверь ставит ступень и ничего не выдумывает', async () => {
    const { front, adapter } = mkFront({ deps: {} }) // без derivePhaseCard

    const res = await post(front, '/api/phase/stage', { phase: '21', stage: 'plan' })

    expect(res.statusCode, res.body).toBe(200)
    expect(await adapter.list({})).toHaveLength(1)
  })
})

// ═══ ПРОВОД ТИКА: КОПИЮ ДОКУМЕНТАРНОЙ СТУПЕНИ РЕЖУТ ИЗ ДОМА ПЛАНИРОВАНИЯ ═══

/** Раннер, записывающий КАТАЛОГ каждой провизии: cwd и есть ответ «из какого дерева». */
function cwdRecordingRunner() {
  const provisions: { cwd: string | undefined }[] = []
  const runner = async (_bin: string, argsArray: string[], opts: any = {}) => {
    const verb = argsArray[1]
    const sub = argsArray[2]
    if (verb === 'worktree' && sub === 'provision') {
      provisions.push({ cwd: opts?.cwd })
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
    // Маршрут подделан ровно как в stage-copy-wire: предмет спора здесь — КАТАЛОГ провизии,
    // а не правило, каким работником закрывается полоса бумажной работы.
    routing: { resolveRoute: () => ({ workerId: 'w-1', provider: 'claude' }) },
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

describe('ПРОВОД: копию ступени фазы режут из дома планирования её проекта', () => {
  const stageRow = {
    id: 'S-1',
    source: 'roster',
    title: '/sma-plan-phase 21 --text --skip-research',
    lane: 'paperwork',
    project: TWO_ADDRESS.id,
    data: { kind: 'document', stage: 'plan', phase: '21' },
  }

  it('документарная ступень — из ДОМА ПЛАНИРОВАНИЯ, а не из дерева кода', async () => {
    const config = {
      token: TOKEN,
      workers: [{ id: 'w-1', lane: 'paperwork', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      projects: [TWO_ADDRESS],
      activeProject: TWO_ADDRESS.id,
      repoDir: '/repo',
      agingHours: 24,
      backlogScanMinutes: 60,
      pipeline: { enabled: true },
    }
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await adapter.enqueue(stageRow)

    const rec = cwdRecordingRunner()
    await tick(loopDeps(adapter, config, rec.runner))

    expect(rec.provisions, 'копию не отводили вовсе').toHaveLength(1)
    expect(rec.provisions[0].cwd, 'ступень получила копию дерева кода — каталогов фаз в ней нет').toBe(
      TWO_ADDRESS.planningPath,
    )
  })

  it('кодовая работа того же проекта — по-прежнему из ДЕРЕВА КОДА', async () => {
    const config = {
      token: TOKEN,
      workers: [{ id: 'w-1', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      projects: [TWO_ADDRESS],
      activeProject: TWO_ADDRESS.id,
      repoDir: '/repo',
      agingHours: 24,
      backlogScanMinutes: 60,
      pipeline: { enabled: true },
    }
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await adapter.enqueue({ id: 'R-7', source: 'roster', title: 'починить импорт', lane: 'prod', project: TWO_ADDRESS.id })

    const rec = cwdRecordingRunner()
    await tick(loopDeps(adapter, config, rec.runner))

    expect(rec.provisions).toHaveLength(1)
    expect(rec.provisions[0].cwd).toBe(TWO_ADDRESS.path)
  })

  it('без второго адреса ступень режется там же, где и раньше', async () => {
    const config = {
      token: TOKEN,
      workers: [{ id: 'w-1', lane: 'paperwork', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      projects: [PRODUCT],
      activeProject: PRODUCT.id,
      repoDir: '/repo',
      agingHours: 24,
      backlogScanMinutes: 60,
      pipeline: { enabled: true },
    }
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    await adapter.enqueue({ ...stageRow, project: PRODUCT.id })

    const rec = cwdRecordingRunner()
    await tick(loopDeps(adapter, config, rec.runner))

    expect(rec.provisions).toHaveLength(1)
    expect(rec.provisions[0].cwd).toBe(PRODUCT.path)
  })
})
