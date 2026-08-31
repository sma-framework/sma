/**
 * ОДИН СЧЁТ ИЗМЕНЕНИЙ НА ДВЕ ПОВЕРХНОСТИ — тест ПРОВОДА, а не арифметики.
 *
 * На карточке задачи стоят две поверхности, отвечающие на один вопрос «что изменено».
 * Панель ростера считала всю ветку (`git diff HEAD...wt/<id>`), а дверь диффа отдавала
 * `git show wt/<id>` — последний коммит и ничего больше; окно выводит свои «+N −M» из текста
 * этой двери. На задаче с одним коммитом числа совпадали, и расхождение было невидимо; на
 * задаче с тремя карточка перечисляла три коммита рядом с изменениями одного из них.
 *
 * Поэтому здесь проверяется ВЫЗОВ, а не совпадение чисел на удачном примере: обе поверхности
 * прогоняются на одном шве `front/task-changes.mjs`, и утверждение — что каждая в него
 * ЗАШЛА. Тест, сверяющий два числа, был бы зелёным и в тот день, когда кто-нибудь заведёт
 * второе вычисление, случайно дающее тот же ответ на однокоммитной задаче; тест на вызов
 * краснеет в тот момент, когда поверхность считает сама.
 *
 * Второе дело — на НАСТОЯЩЕМ репозитории с несколькими коммитами: подделка отвечала бы здесь
 * из того самого допущения, которое проверяется («что показывает git на диапазоне»), а
 * дефект был виден именно в разнице между одним коммитом и веткой целиком.
 *
 * ШВОВ ЗАПУСКА СТАЛО ДВА, ВОПРОС ОСТАЛСЯ ОДИН. Панель ростера больше не спрашивает git на
 * пути ответа двери состояния — холодная сборка выдачи стоила 272 подпроцесса, — и заходит в
 * тот же шов на ДОСЫЛКЕ (`warmDoneGit`), забирая оттуда аргументы (`taskChangeArgs`) для
 * асинхронного бегуна. Поэтому здесь записываются оба входа: дверь диффа читает шов целиком,
 * панель берёт у него диапазон. Утверждение прежнее и единственное: ни одна из поверхностей
 * не считает сама.
 */

import { describe, it, expect, vi, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// Шов подменяется ОБЁРТКОЙ, а не заглушкой: настоящая функция вызывается насквозь, поэтому
// дело ниже остаётся делом о поведении, а запись вызовов — доказательством провода.
vi.mock('../src/front/task-changes.mjs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/front/task-changes.mjs')>()
  return { ...real, readTaskChanges: vi.fn(real.readTaskChanges), taskChangeArgs: vi.fn(real.taskChangeArgs) }
})

import { readTaskChanges, taskChangeArgs, taskChangeRange } from '../src/front/task-changes.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { deriveState, warmDoneGit } from '../src/front/state.mjs'

const seam = vi.mocked(readTaskChanges)
/** Вход панели ростера: она берёт у того же шва диапазон и запускает его сама, асинхронно. */
const argsSeam = vi.mocked(taskChangeArgs)
const TOKEN = 'a'.repeat(64)

// ── the smallest fake req/res a door needs ──

function mkReq(url: string) {
  const req: any = Readable.from([])
  req.method = 'GET'
  req.url = url
  req.headers = { authorization: `Bearer ${TOKEN}` }
  req.socket = { remoteAddress: '10.0.0.1' }
  return req
}

function mkRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, any>,
    body: '',
    headersSent: false,
    writeHead(code: number, h?: any) {
      res.statusCode = code
      res.headersSent = true
      if (h) for (const [k, v] of Object.entries(h)) res.headers[k.toLowerCase()] = v
      return res
    },
    setHeader(k: string, v: any) {
      res.headers[k.toLowerCase()] = v
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()]
    },
    write(c: any) {
      res.body += String(c)
      return true
    },
    end(c?: any) {
      if (c != null) res.body += String(c)
      res.ended = true
      return res
    },
  }
  return res
}

async function askDiffDoor(deps: any, id: string) {
  const front = createFrontServer({ config: { token: TOKEN }, deps })
  const res = mkRes()
  await front.handle(mkReq(`/api/diff/${id}`), res)
  return res
}

const config = { agingHours: 24, budget: { monthlyApiCapUsd: 50 }, workers: [] as any[] }
const windows = () => ({
  fiveHour: { status: 'open', resetsAt: null, pct: null, observedAt: null },
  week: { status: 'open', resetsAt: null, pct: null, observedAt: null },
})

/** Одна завершённая задача — то, ради чего панель вообще спрашивает git. */
const mkAdapter = (rows: any[]) => ({ list: async () => rows.slice() })

const repos: string[] = []
afterAll(() => {
  for (const d of repos) rmSync(d, { recursive: true, force: true })
})

describe('счёт изменений — обе поверхности берут его из одного вычисления', () => {
  it('панель ростера и дверь диффа ЗАХОДЯТ в один шов, каждая со своей формой ответа', async () => {
    // Идентификатор свой у каждого дела: git-факты завершённой задачи запоминаются, и второе
    // дело с тем же именем читало бы память, а не провод.
    const id = 'R-1787850459572'
    seam.mockClear()
    argsSeam.mockClear()
    const argv: string[][] = []
    const execGit = (args: string[]) => {
      argv.push(args)
      return args[0] === 'log' ? 'abc1234 сделал дело' : ' 3 files changed, 9 insertions(+)'
    }

    const res = await askDiffDoor({ execGit, repoDir: '/repo' }, id)
    expect(res.statusCode).toBe(200)
    expect(seam.mock.calls).toHaveLength(1)

    await deriveState({
      adapter: mkAdapter([{ id, status: 'completed', lane: 'prod', title: 'ночная', completedAt: 1_000_000_000_000 }]),
      windows,
      execGit,
      repoDir: '/repo',
      config,
      clock: () => 1_000_000_000_000,
    })

    // ДВЕРЬ СОСТОЯНИЯ НЕ ПЛАТИТ ЗА ЭТО НИЧЕГО: на пути ответа панель git не спрашивает вовсе,
    // поэтому и в шов ещё не заходила. Холодный ответ на 136 закрытых работах стоил 272
    // подпроцесса — это и есть та цена, которой здесь быть не должно.
    expect(argsSeam.mock.calls).toHaveLength(0)
    expect(argv.filter((a) => a[0] === 'diff')).toHaveLength(1) // только дверь диффа

    await warmDoneGit({ execGit, tasks: [id] })

    // ДВА ВХОДА В ОДИН ШОВ — по одному на поверхность. Поверхность, которая посчитает сама,
    // здесь не появится, и это единственное, что отличает провод от совпадения чисел.
    expect(seam.mock.calls).toHaveLength(1) // дверь диффа — целиком через шов
    expect(argsSeam.mock.calls).toHaveLength(1) // панель ростера — за диапазоном
    expect(seam.mock.calls.map((c) => c[0])).toEqual([id])
    expect(argsSeam.mock.calls.map((c) => c[0])).toEqual([id])
    // Формы ответа разные (двери нужен патч, панели — счёт), а спрошенный диапазон один.
    expect(seam.mock.calls.map((c) => (c[2] as any)?.shape)).toEqual(['patch'])
    expect(argsSeam.mock.calls.map((c) => c[1])).toEqual(['count'])
    expect(argv.filter((a) => a[0] === 'diff').map((a) => a[a.length - 1])).toEqual([
      taskChangeRange(id),
      taskChangeRange(id),
    ])
  })

  it('на НАСТОЯЩЕЙ ветке с тремя коммитами дверь показывает всю работу задачи, а не её последний коммит', async () => {
    const id = 'R-1787850459573'
    seam.mockClear()
    const repo = mkdtempSync(join(tmpdir(), 'sma-changes-'))
    repos.push(repo)
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
    // Личность ставится ВНУТРИ одноразового репозитория, никогда на машине.
    git(['init', '-q'])
    git(['config', 'user.email', 'suite@example.invalid'])
    git(['config', 'user.name', 'suite'])
    git(['config', 'commit.gpgsign', 'false'])
    git(['config', 'core.autocrlf', 'false'])
    writeFileSync(join(repo, 'base.txt'), 'base\n', 'utf8')
    git(['add', '--', 'base.txt'])
    git(['commit', '-q', '--no-verify', '-m', 'основание'])
    const trunk = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()

    git(['checkout', '-q', '-b', `wt/${id}`])
    for (const name of ['one.txt', 'two.txt', 'three.txt']) {
      writeFileSync(join(repo, name), `${name}\n`, 'utf8')
      git(['add', '--', name])
      git(['commit', '-q', '--no-verify', '-m', `коммит ${name}`])
    }
    // Демон стоит в стволе, как и всегда: ветку задачи он читает со стороны.
    git(['checkout', '-q', trunk])

    const execGit = (args: string[], opts: any = {}) =>
      execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

    const res = await askDiffDoor({ execGit, repoDir: repo }, id)
    expect(res.statusCode).toBe(200)
    // Все три коммита ветки, а не только вершина — `git show` показал бы один three.txt.
    expect(res.body).toContain('one.txt')
    expect(res.body).toContain('two.txt')
    expect(res.body).toContain('three.txt')

    const ask = {
      adapter: mkAdapter([{ id, status: 'completed', lane: 'prod', title: 'ночная', completedAt: 1_000_000_000_000 }]),
      windows,
      execGit,
      repoDir: repo,
      config,
      clock: () => 1_000_000_000_000,
    }
    // Первый ответ двери историю ещё не знает и честно об этом говорит; досылка спрашивает
    // git у настоящей ветки, и второй ответ её несёт.
    const cold = await deriveState(ask)
    expect(cold.done[0].diffStat).toBeNull()
    expect(cold.done[0].gitPending).toBe(true)
    await warmDoneGit({ execGit, tasks: [id] })
    const payload = await deriveState(ask)
    // И раз вопрос один, ответы сходятся на настоящей задаче: панель насчитала те же три файла.
    expect(payload.done[0].diffStat).toContain('3 files changed')
  })
})
