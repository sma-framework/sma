/**
 * СКВОЗНОЙ ПРОГОН ОДНОЙ КАРТОЧКИ: реестр мастерской → очередь → работник → ПРИЁМКА ЧЕЛОВЕКОМ →
 * следующий обход. Одно дело, четыре двери, ни одной подделки между ними.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Обе половины починки уже стоят под своими делами: обход беклога
 * спрашивает два источника (loop.test.ts), приёмка пишет закрытие карточки в реестр
 * (front-auth.test.ts), захват спрашивает последнее слово (loop.test.ts). Каждая из них зелена
 * ПОРОЗНЬ — и ровно так же порознь они были зелены в тот день, когда принятая и слитая работа
 * вернулась в очередь: дыра лежала не внутри двери, а МЕЖДУ дверями. Дело, которое переходит
 * границу модулей, — единственное, которое может об этом сказать.
 *
 * ЧТО ЗДЕСЬ НАСТОЯЩЕЕ: тик демона, эталонная очередь, реестр попыток НА ДИСКЕ и дверь «Одобрить»
 * фронта — со своим CAS, своим ритуалом слияния и своей записью в реестр. Подделаны ровно три
 * вещи, и ни одна из них не про предмет дела: сканер файла беклога (файла на диске здесь нет),
 * запуск работника (процесса нет) и ритуал слияния (репозитория нет).
 *
 * ПОСЛЕДНИЙ ШАГ — ПРО СРОК ХРАНЕНИЯ. Долговечная очередь уносит законченную строку в архив, после
 * чего спросить её о карточке нельзя вовсе; это смоделировано ПУСТОЙ очередью с тем же реестром.
 * Именно в этом состоянии система и минтила дубль 31.08.2026.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { tick } from '../src/loop.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { recordAttempt, readAttempts, closureOf } from '../src/queue/attempt-ledger.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

const TOKEN = 'a'.repeat(64)
const CARD = 'SB-176'

const tmpDirs: string[] = []
function mkLedgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-e2e-ledger-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

// ── the front door, driven with fake req/res (no socket) ──

function mkReq(o: any = {}) {
  const { method = 'GET', url = '/', headers = {}, body } = o
  const payload = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req: any = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1', ...headers }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    setHeader(k: string, v: any) {
      this.headers[k.toLowerCase()] = v
    },
    writeHead(code: number, hdrs: any = {}) {
      this.statusCode = code
      for (const [k, v] of Object.entries(hdrs)) this.setHeader(k, v)
      return this
    },
    end(chunk?: any) {
      if (chunk) this.body += String(chunk)
      return this
    },
  }
  return res
}

async function call(front: any, reqOpts: any) {
  const req = mkReq(reqOpts)
  const res = mkRes()
  await front.handle(req, res)
  return res
}

/** The approval side table, modelled as the one row this test moves through it. */
function makeCasExec(initialStatus: string) {
  const state = { status: initialStatus }
  const exec = async (_sql: string, params: any[]) => {
    const to = params[0]
    const from = params[params.length - 1]
    if (state.status === from) {
      state.status = to
      return { rows: [{ id: 'row' }] }
    }
    return { rows: [] }
  }
  ;(exec as any).state = state
  return exec
}

// ── the tick, assembled from the real modules ──

const ledgerSeam = (dir: string) => ({
  recordAttempt: (row: any) => recordAttempt(dir, row),
  readAttempts: (id: string) => readAttempts(dir, id),
})

function makeTickDeps({ adapter, ledger, clock, intake }: any) {
  const order: string[] = []
  const journalled: any[] = []
  const deps: any = {
    adapter,
    ledger,
    config: {
      workers: [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: '/repo',
      pipeline: { enabled: true },
    },
    routing: { resolveRoute },
    windows: () => true,
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: 'do it' }),
    verbRunner: async (_bin: string, args: string[]) => {
      const verb = args[1]
      order.push(verb)
      if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
      if (verb === 'worktree') {
        return { code: 0, stdout: JSON.stringify({ ok: true, path: `/wt/${CARD}`, branch: `wt/${CARD}` }) }
      }
      if (verb === 'reverify') {
        return { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }) }
      }
      return { code: 0, stdout: '{}' }
    },
    spawnWorker: (spec: any) => {
      order.push('spawn')
      spec.onLine?.('APPROACH_NOTE: прямой путь')
      spec.onLine?.('LESSON_NONE: тестовый работник')
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    report: async () => {},
    clock,
    journal: (e: any) => journalled.push(e),
    intake,
  }
  return { deps, order, journalled }
}

/** Одна открытая строка реестра мастерской, как её отдаёт сканер файла. */
const backlogLine = () => ({
  id: CARD,
  source: 'backlog',
  title: 'починить дверь приёмки',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'зелёные прицельные тесты + квитанция reverify',
})

describe('карточка → приёмка → следующий обход: дубля не возникает ни одним путём', () => {
  it('сквозной прогон: работа доезжает до приёмки, приёмка закрывает карточку, обход её не ставит, а призрака не выдают', async () => {
    const dir = mkLedgerDir()
    const ledger = ledgerSeam(dir)
    let t = 1_700_000_000_000
    const clock = () => t

    // ── (1) КАРТОЧКА: обход реестра ставит строку, тик тут же берёт её в работу ──────────
    const queue = createMemoryQueue({ clock, expireMs: 300000 })
    const first = makeTickDeps({
      adapter: queue,
      ledger,
      clock,
      intake: { lastScanAt: 0, scan: async () => ({ items: [backlogLine()], notReady: [] }) },
    })
    const run: any = await tick(first.deps)

    expect(run.intake.enqueued).toBe(1)
    expect(run.completed).toBe(CARD)
    expect(first.order).toEqual(['worktree', 'reverify', 'spawn', 'reverify'])
    const [afterRun]: any = await queue.list({})
    expect(afterRun.status).toBe('awaiting_approval') // работа сделана и ждёт слова человека
    // реестр уже знает попытку — и знает ветку, по которой приёмка будет сливать
    const done: any = readAttempts(dir, CARD).find((r: any) => r.outcome === 'completed')
    expect(done.receiptRef).toBe('reverify:abc')
    expect(done.branch).toBe(`wt/${CARD}`)
    // а закрытия карточки нет: его пишет ЧЕЛОВЕК, и до его нажатия его быть не должно
    expect(closureOf(readAttempts(dir, CARD))).toBeNull()

    // ── (2) ПРИЁМКА: настоящая дверь «Одобрить», настоящий CAS, настоящая запись в реестр ──
    t += 9 * 60_000
    const front = createFrontServer({
      config: { token: TOKEN },
      deps: {
        casExec: makeCasExec('awaiting_approval'),
        verbRunner: async (o: any) => ({
          merged: true,
          testsPassed: true,
          branch: o.branch,
          receipt: { branch: o.branch, testsPassed: true, mergeSha: '504b61a9' },
        }),
        adapter: queue,
        ledger,
        repoDir: '/repo',
        clock,
      },
    })
    const approved = await call(front, {
      method: 'POST',
      url: '/api/approve',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: { taskId: CARD },
    })
    expect(approved.statusCode).toBe(200)
    expect(JSON.parse(approved.body).merged).toBe(true)

    const closed: any = closureOf(readAttempts(dir, CARD))
    expect(closed).not.toBeNull()
    expect(closed.by).toBe('approve')
    expect(closed.merged).toBe(true)
    expect(closed.at).toBe(new Date(t).toISOString())

    // ── (3) СЛЕДУЮЩИЙ ОБХОД, КОГДА ОЧЕРЕДЬ УЖЕ ЗАБЫЛА. Строка файла беклога осталась открытой
    //        (её ведёт человек, и эта дверь его файла не правит), а строку очереди унёс архив по
    //        сроку хранения — смоделировано пустой очередью с тем же реестром.
    t += 60 * 60_000
    const forgetful = createMemoryQueue({ clock, expireMs: 300000 })
    const second = makeTickDeps({
      adapter: forgetful,
      ledger,
      clock,
      intake: { lastScanAt: 0, scan: async () => ({ items: [backlogLine()], notReady: [] }) },
    })
    const rescan: any = await tick(second.deps)

    expect(rescan.intake.enqueued, 'принятая и слитая работа поставлена в очередь заново').toBe(0)
    expect(rescan.intake.known).toEqual([CARD])
    expect(await forgetful.list({})).toEqual([]) // очередь осталась пустой
    expect(second.order).toEqual([]) // никакой копии и никакого работника

    // ── (4) …И ПРИЗРАК, КОТОРОГО ОБХОД ОТЧЕКАНИЛ РАНЬШЕ ПРИЁМКИ. Строка уже стоит в очереди —
    //        обходу её ставить не надо, а вот выдать её захват был обязан отказаться сам.
    t += 60 * 60_000
    await forgetful.enqueue(backlogLine())
    const third = makeTickDeps({
      adapter: forgetful,
      ledger,
      clock,
      intake: { lastScanAt: t, scan: async () => ({ items: [backlogLine()], notReady: [] }) },
    })
    const ghostRun: any = await tick(third.deps)

    expect(ghostRun.refusedClaim).toEqual({ taskId: CARD, code: 'card_closed' })
    expect(third.order, 'по принятой работе запущен работник').toEqual([])
    const [ghost]: any = await forgetful.list({})
    expect(ghost.status).toBe('failed')
    expect(ghost.failure_reason).toBe('already_decided')
  })
})
