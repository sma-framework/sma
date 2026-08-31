/**
 * ДОКУМЕНТАРНАЯ СТУПЕНЬ ПИШЕТ В СВОЮ КОПИЮ, А ГЛАВНОЕ ДЕРЕВО МЕНЯЕТ ПРИЁМКА.
 *
 * ═══════════════ ЗАЧЕМ ЭТОТ СЬЮТ СУЩЕСТВУЕТ ОТДЕЛЬНО ═══════════════════════════════════
 * ЗАМЕРЕНО 31.08.2026: ступень plan фазы 21, поставленная дверью фронта, положила семь планов
 * ДВУМЯ КОММИТАМИ ПРЯМО В main рабочего дерева мастерской, авторством основателя, и ветки
 * `wt/S-…` для неё не заводилось вовсе — при том что кодовая задача `wt/B-…` получает копию
 * штатно. Та же попытка срывалась дважды: сорвавшаяся ступень оставляла свои правки в main без
 * всякого следа приёмки, и откат был возможен лишь ручным `git revert` по хэшам, найденным
 * задним числом.
 *
 * ЧТО ЗДЕСЬ УТВЕРЖДАЕТСЯ — ПРОВОД, А НЕ ВЫЧИСЛЕНИЕ. Дверь настоящая, очередь настоящая, тик
 * настоящий; подделаны ровно две внешние руки — верб (git) и запуск работника, — потому что
 * ровно их адреса и есть предмет спора:
 *
 *   А. КОПИЯ И ВЕТКА. Ступень, поставленная дверью `/api/phase/stage`, проходит провизию копии
 *      с веткой `wt/<id задачи>`, и РАБОТНИК СТОИТ В КОПИИ — не в дереве планирования. Это
 *      утверждается для КАЖДОЙ документарной ступени словаря (discuss, plan, design, verify),
 *      потому что машинерия у них одна и «проверено на plan» ничего не говорит о verify.
 *   Б. СРЫВ НИЧЕГО НЕ ОСТАВЛЯЕТ В ГЛАВНОМ ДЕРЕВЕ. Ступень, не оставившая документа, падает —
 *      и работник её всё равно стоял в копии, а строка попытки несёт ветку, по которой правки
 *      находятся и снимаются целиком.
 *   В. ВХОД В ДЕРЕВО — ТОЛЬКО ПРИЁМКА. Нажатие «Одобрить» зовёт ритуал слияния на `wt/<id>`,
 *      в дереве планирования. До нажатия дерево не менялось никем, кроме человека.
 *
 * ПОЧЕМУ ИМЕННО «cwd РАБОТНИКА». Коммит делает работник, а не тик: единственное место, где
 * решается, В КАКОМ ДЕРЕВЕ он окажется, — это `cwd` запуска. Утверждение о нём и есть
 * утверждение «main не меняется»; всё остальное было бы пересказом намерения.
 */

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

import { createFrontServer } from '../src/front/server.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { tick } from '../src/loop.mjs'
import { STAGE_ARTIFACTS } from '../src/front/questions.mjs'

const TOKEN = 'c'.repeat(64)
const PROJECT = '/proj'
const PHASE = '21'
const PHASE_DIR = `.planning/phases/${PHASE}-front`
const NOW = 1_770_000_000_000
const TASK_ID = `S-${NOW}`
/** Куда верб провизии кладёт копию — сосед дерева, как на настоящем диске. */
const COPY = '/copies/wt-S-1770000000000'
const BRANCH = `wt/${TASK_ID}`

// ── дерево в памяти (форма фикстур design-stage-wire.test.ts, не изобретённая заново) ──

function norm(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

function fakeFs(initial: Record<string, string>) {
  const files = new Map<string, string>()
  for (const [k, v] of Object.entries(initial)) files.set(norm(k), v)

  const dirSet = () => {
    const dirs = new Set<string>(['/'])
    for (const p of files.keys()) {
      const parts = p.split('/')
      parts.pop()
      let acc = ''
      for (const part of parts) {
        acc = acc === '' ? (part === '' ? '/' : part) : acc === '/' ? `/${part}` : `${acc}/${part}`
        dirs.add(acc)
      }
    }
    return dirs
  }

  return {
    existsSync(p: string) {
      const k = norm(p)
      return files.has(k) || dirSet().has(k)
    },
    readdirSync(p: string) {
      const k = norm(p)
      const out = new Set<string>()
      for (const f of files.keys()) {
        if (!f.startsWith(`${k}/`)) continue
        out.add(f.slice(k.length + 1).split('/')[0])
      }
      return [...out].sort()
    },
    readFileSync(p: string) {
      const k = norm(p)
      if (!files.has(k)) throw new Error(`ENOENT: ${k}`)
      return files.get(k) as string
    },
    statSync(p: string) {
      const k = norm(p)
      const isFile = files.has(k)
      if (!isFile && !dirSet().has(k)) throw new Error(`ENOENT: ${k}`)
      return { isDirectory: () => !isFile, isFile: () => isFile }
    },
    mkdirSync() {},
    writeFileSync(p: string, text: string) {
      files.set(norm(p), String(text))
    },
    renameSync() {},
    unlinkSync(p: string) {
      files.delete(norm(p))
    },
  }
}

// ── дверь ──

function mkReq(url: string, body?: unknown) {
  const req: any = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  req.socket = { remoteAddress: '10.0.0.7' }
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

/** CAS-шов с настоящей семантикой from/to — начальное состояние берётся у очереди. */
function casSeam(adapter: any) {
  const states = new Map<string, string>()
  const execSql = async (_sql: string, params: any[]) => {
    const to = params[0]
    const from = params[params.length - 1]
    const id = params[params.length - 2]
    if (!states.has(id)) {
      const rows = await adapter.list({})
      const row = rows.find((r: any) => r.id === id)
      states.set(id, row ? row.status : 'unknown')
    }
    if (states.get(id) !== from) return { rows: [] }
    states.set(id, to)
    return { rows: [{ id }] }
  }
  return { execSql }
}

// ── тик ──

/**
 * Настоящий тик над настоящей очередью; подделаны git-верб и запуск работника.
 *
 * Верб отвечает так, как отвечает настоящий: провизия называет путь копии и точку отсчёта,
 * всё остальное — пустой объект. Запуск записывает СВОЙ cwd — это и есть предмет утверждения.
 */
function tickDeps(adapter: any, io: any, opts: { committed?: Record<string, string> } = {}) {
  const attempts: any[] = []
  const verbCalls: Array<{ verb: string; args: string[]; cwd?: string }> = []
  const spawnCwds: string[] = []
  const committed = opts.committed ?? {}

  const deps: any = {
    adapter,
    ledger: {
      recordAttempt: (a: any) => {
        attempts.push(a)
        return a
      },
      readAttempts: (id: string) => attempts.filter((x) => x.taskId === id),
    },
    config: {
      workers: [{ id: 'w-1', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: PROJECT,
      pipeline: { enabled: true },
    },
    routing: { resolveRoute: () => ({ workerId: 'w-1', provider: 'claude' }) },
    windows: () => true,
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
    verbRunner: async (_bin: string, argsArray: string[], o: any) => {
      const verb = argsArray[1]
      verbCalls.push({ verb, args: argsArray.slice(2), cwd: o && o.cwd })
      if (verb === 'worktree') {
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, path: COPY, branch: BRANCH, expectedBase: 'base1234', materialized: [] }),
        }
      }
      return { code: 0, stdout: '{}' }
    },
    spawnWorker: (spec: any) => {
      spawnCwds.push(spec.cwd)
      for (const l of ['stream line', 'APPROACH_NOTE: прямой путь', 'LESSON_NONE: тестовый работник']) spec.onLine?.(l)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 7, kill: () => {} }
    },
    report: async () => {},
    clock: () => NOW,
    journal: () => {},
    fsImpl: io,
    // git знает ровно то, что закоммичено: путь → короткий хэш. Всё прочее — пустая строка,
    // и гейт документа честно читает это как «истории он не достался».
    execGit: (args: string[]) => {
      const dash = args.indexOf('--')
      if (dash !== -1) return committed[String(args[dash + 1])] ?? ''
      return ''
    },
  }
  return { deps, attempts, verbCalls, spawnCwds }
}

/** Ступень, поставленная НАСТОЯЩЕЙ дверью, — не строка, собранная руками теста. */
async function stageThroughTheDoor(adapter: any, io: any, stage: string) {
  const front = createFrontServer({
    config: { token: TOKEN },
    deps: { repoDir: PROJECT, fsImpl: io, clock: () => NOW, adapter, hub: { emit: () => {} } },
  })
  const res = await post(front, '/api/phase/stage', { phase: PHASE, stage })
  expect(res.statusCode, res.body).toBe(200)
  return { front, taskId: JSON.parse(res.body).taskId as string }
}

// ═══════════ А · КАЖДАЯ ДОКУМЕНТАРНАЯ СТУПЕНЬ ПОЛУЧАЕТ КОПИЮ И ВЕТКУ ═══════════════════

describe('А · документарная ступень исполняется в своей копии на своей ветке', () => {
  for (const stage of ['discuss', 'plan', 'design', 'verify'] as const) {
    const produces = (STAGE_ARTIFACTS as any)[stage].produces as string
    const artifact = `${PHASE_DIR}/${PHASE}${produces}`

    it(`ступень "${stage}": провизия ветки ${BRANCH}, работник стоит в копии, а не в дереве планирования`, async () => {
      const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
      // документ лежит В КОПИИ — там, где его оставил бы работник, стоящий в копии
      const io = fakeFs({ [`${COPY}/${artifact}`]: '# документ', [`${PROJECT}/${PHASE_DIR}/${PHASE}-CONTEXT.md`]: '# о фазе' })
      const { taskId } = await stageThroughTheDoor(adapter, io, stage)
      expect(taskId).toBe(TASK_ID)

      const { deps, attempts, verbCalls, spawnCwds } = tickDeps(adapter, io, {
        committed: { [artifact]: 'abc1234' },
      })
      const res = await tick(deps)

      expect(res.completed, `ступень "${stage}" не дошла до конца`).toBe(taskId)
      // копия заведена, и заведена ПОД ИМЕНЕМ ЗАДАЧИ
      const provision = verbCalls.find((c) => c.verb === 'worktree')
      expect(provision, 'документарная ступень прошла мимо провизии копии').toBeTruthy()
      expect(provision!.args).toContain('provision')
      expect(provision!.args).toContain('--branch')
      expect(provision!.args[provision!.args.indexOf('--branch') + 1]).toBe(BRANCH)
      // …и работник стоит в ней, а не в дереве, где работает человек
      expect(spawnCwds).toEqual([COPY])
      expect(spawnCwds).not.toContain(PROJECT)
      // строка попытки несёт ветку — иначе приёмке нечего сливать, а откату нечего называть
      expect(attempts[0].branch).toBe(BRANCH)
      expect(attempts[0].worktreePath).toBe(COPY)
      // квитанция — документ, найденный В КОПИИ (в дереве планирования его нет вовсе), и
      // коммит, который его несёт
      expect(attempts[0].receiptRef).toBe(`artifact:${artifact}@abc1234`)
      const [row] = (await adapter.list({})).filter((r: any) => r.id === taskId)
      expect(row.status, 'документ вошёл бы в дерево без приёмки').toBe('awaiting_approval')
    })
  }
})

// ═══════════ Б · СОРВАВШАЯСЯ СТУПЕНЬ НЕ ОСТАВЛЯЕТ СЛЕДА В ГЛАВНОМ ДЕРЕВЕ ═══════════════

describe('Б · срыв ступени ничего не оставляет в дереве планирования', () => {
  it('ступень без документа падает — и её работник всё равно стоял в копии, на своей ветке', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    // документа нет нигде: ни в копии, ни тем более в дереве
    const io = fakeFs({ [`${PROJECT}/${PHASE_DIR}/${PHASE}-CONTEXT.md`]: '# о фазе', [`${COPY}/.keep`]: '' })
    const { taskId } = await stageThroughTheDoor(adapter, io, 'plan')

    const { deps, attempts, spawnCwds } = tickDeps(adapter, io)
    const res = await tick(deps)

    expect(res.failed).toMatchObject({ taskId, reason: 'no_artifact' })
    expect(spawnCwds, 'сорвавшаяся ступень писала в дерево планирования').toEqual([COPY])
    // ветка названа и у ПРОВАЛИВШЕЙСЯ попытки: именно её кто-то захочет откатить
    expect(attempts[0].branch).toBe(BRANCH)
  })
})

// ═══════════ В · ВХОД В ДЕРЕВО ПЛАНИРОВАНИЯ — ТОЛЬКО ЧЕРЕЗ ПРИЁМКУ ═════════════════════

describe('В · артефакты ступени входят в дерево только приёмкой человека', () => {
  it('«Одобрить» зовёт ритуал слияния на ветке ступени, в дереве планирования', async () => {
    const adapter = createMemoryQueue({ clock: () => NOW, expireMs: 300000 })
    const artifact = `${PHASE_DIR}/${PHASE}-01-PLAN.md`
    const io = fakeFs({ [`${COPY}/${artifact}`]: '# план' })
    const { taskId } = await stageThroughTheDoor(adapter, io, 'plan')
    const { deps, attempts } = tickDeps(adapter, io, { committed: { [artifact]: 'abc1234' } })
    await tick(deps)

    const merges: any[] = []
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        repoDir: PROJECT,
        fsImpl: io,
        clock: () => NOW,
        adapter,
        hub: { emit: () => {} },
        casExec: casSeam(adapter).execSql,
        ledger: { readAttempts: (id: string) => attempts.filter((a) => a.taskId === id) },
        verbRunner: async (o: any) => {
          merges.push(o)
          return { merged: true, testsPassed: true, receipt: { sha: 'f'.repeat(40), repo: PROJECT } }
        },
      },
    })

    const res = await post(front, '/api/approve', { taskId })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).merged).toBe(true)
    expect(merges, 'приёмка ничего не слила — значит документ вошёл в дерево мимо неё').toHaveLength(1)
    expect(merges[0].branch).toBe(BRANCH)
    expect(merges[0].cwd).toBe(PROJECT)
  })
})
