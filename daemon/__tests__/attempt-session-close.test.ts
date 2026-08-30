/**
 * КОНЕЦ ПОПЫТКИ ЗАКРЫВАЕТ КООРДИНАЦИОННУЮ СЕССИЮ — иначе мёртвая попытка оставляет окно.
 *
 * ═══════════════ ЧТО ЛОМАЛОСЬ, ИЗМЕРЕННОЕ НА ЖИВОМ ВЕЧЕРЕ ═══════════════════════════
 * Каждая сессия работника при старте регистрируется в координации: хук начала сессии
 * заводит ей читаемое имя («Окно-26») и лизу в общем каталоге. Закрывает эту запись
 * ПАРНЫЙ хук конца сессии — тот, что живёт внутри самого процесса. За вечер шести
 * сгоревших попыток в реестре осталось шесть окон подряд: процесс, убитый или ушедший
 * не своей дорогой, парного хука не исполняет, и координация продолжает считать живыми
 * окна, за которыми нет ни одного процесса.
 *
 * ЦЕНА НЕ КОСМЕТИЧЕСКАЯ. По этим лизам дом отвечает на вопрос «кто сейчас работает»:
 * их читает статус, по ним расходятся заявки на файлы и по ним же считается, свободен ли
 * кто-нибудь. Реестр, полный призраков, — это шторм ложных коллизий у живого человека.
 *
 * ПОЧЕМУ ЗАКРЫВАЕТ ТИК, А НЕ ХУК. Хук — внутри процесса, и именно поэтому он и не
 * исполняется у процесса, который умер: доверять уборку тому, кого убирают, нельзя.
 * Тик — единственное место, которое ПЕРЕЖИВАЕТ попытку при любом её исходе, поэтому
 * закрытие стоит в его последнем `finally`, а не на счастливой дороге.
 *
 * ЧЕМ ОН АДРЕСУЕТ ОКНО. Идентичность окна выводится из токена сессии; тик знает его из
 * потока (тем же числом он продолжает сессию после поправки). Никакого угадывания имени
 * файла: имя окна разрешает та же библиотека, что его выдавала, — тик только называет ей
 * токен. Нет токена — нет и закрытия: демон не закрывает окно, о котором ничего не знает.
 *
 * ЭТОТ ФАЙЛ КРАСЕН ПРИ РОЖДЕНИИ: сегодня тик не закрывает ничего.
 */

import { describe, it, expect } from 'vitest'

import { tick } from '../src/loop.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

const PROJECT = '/repo'
const PHASE = '20'
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001'

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const stageTask = (over: Record<string, unknown> = {}) => ({
  id: 'S-1788110314981',
  source: 'roster', // ступень едет тем же источником, каким её ставит дверь фазы
  title: '/sma-plan-phase 20 --text --skip-research',
  lane: 'paperwork',
  priority: 0,
  storyPoints: 3,
  acceptance: 'PLAN.md в каталоге фазы',
  data: { kind: 'document', stage: 'plan', phase: PHASE },
  ...over,
})

/** Работник, который открывает сессию (кадр init с номером), говорит и выходит. */
function spawnWorker(opts: { session?: string | null; lines?: string[] } = {}) {
  const { session = SESSION, lines = ['APPROACH_NOTE: прямой путь', 'LESSON_NONE: тестовый работник'] } = opts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (spec: any) => {
    if (session) spec.onLine?.(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }))
    for (const l of lines) spec.onLine?.(l)
    spec.onExit?.({ code: 0, signal: null })
    return { pid: 4242, kill: () => {} }
  }
}

type VerbCall = { verb: string; args: string[]; cwd?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeps(over: any = {}) {
  const calls: VerbCall[] = []
  const journalled: unknown[] = []
  const c = over.clockObj ?? mkClock()
  const deps = {
    adapter: over.adapter,
    ledger: { recordAttempt: (a: unknown) => a, readAttempts: () => [] },
    config: {
      workers: [{ id: 'max-1', lane: 'paperwork', provider: 'claude', account: { configDir: '/x' }, enabled: true }],
      repoDir: PROJECT,
      pipeline: { enabled: true },
      // Полоса бумажной работы по умолчанию уходит к другому провайдеру; здесь важен не он, а
      // провод закрытия окна, поэтому маршрут полосы назван явно — иначе задачу никто не возьмёт.
      laneRouting: { paperwork: { provider: 'claude' } },
      ...over.config,
    },
    routing: { resolveRoute },
    windows: () => true,
    buildArgs: () => ({ bin: 'claude', args: ['--print', '-'], env: {}, prompt: '/sma-plan-phase 20 --text --skip-research' }),
    verbRunner: async (_bin: string, argsArray: string[], o: { cwd?: string } = {}) => {
      calls.push({ verb: argsArray[1], args: argsArray.slice(2), cwd: o.cwd })
      return { code: 0, stdout: '{}' }
    },
    spawnWorker: over.spawnWorker ?? spawnWorker(),
    report: async () => {},
    clock: c.clock,
    journal: (e: unknown) => journalled.push(e),
    ...over.deps,
  }
  return { deps, calls, journalled }
}

/** Вызовы закрытия сессии, отфильтрованные из всего, что тик спросил у верба. */
const closes = (calls: VerbCall[]) => calls.filter((x) => x.verb === 'session-end')

describe('мёртвая попытка не оставляет окна', () => {
  it('ступень, не написавшая ни файла, всё равно закрывает своё окно координации', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(stageTask())
    const { deps, calls } = makeDeps({ adapter, clockObj: c })

    const res = await tick(deps)

    // попытка честно провалилась — документа нет
    expect(res.failed?.taskId).toBe('S-1788110314981')
    expect(closes(calls)).toHaveLength(1)
    expect(closes(calls)[0].args).toEqual(['--window-token', SESSION])
    expect(closes(calls)[0].cwd).toBe(PROJECT)
  })

  it('окно закрывается РОВНО ОДИН РАЗ за попытку', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(stageTask())
    const { deps, calls } = makeDeps({ adapter, clockObj: c })

    await tick(deps)

    expect(closes(calls)).toHaveLength(1)
  })

  it('сорвавшийся запуск (процесса не было вовсе) окна не открывал — закрывать нечего', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(stageTask())
    const { deps, calls } = makeDeps({
      adapter,
      clockObj: c,
      spawnWorker: () => {
        throw new Error('spawn infra failure')
      },
    })

    await tick(deps)

    expect(closes(calls)).toEqual([])
  })

  it('поток не назвал сессии — демон не гадает, какое окно закрывать', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(stageTask())
    const { deps, calls } = makeDeps({ adapter, clockObj: c, spawnWorker: spawnWorker({ session: null }) })

    await tick(deps)

    expect(closes(calls)).toEqual([])
  })

  it('отказ закрытия не стоит попытке ничего — исход тот же, и он записан', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(stageTask())
    const { deps, journalled } = makeDeps({
      adapter,
      clockObj: c,
      deps: {
        verbRunner: async () => {
          throw new Error('cli недоступен')
        },
      },
    })

    const res = await tick(deps)

    expect(res.failed?.taskId).toBe('S-1788110314981')
    expect(journalled.some((e) => (e as { type?: string }).type === 'task.session_close_failed')).toBe(true)
  })
})

describe('удавшаяся попытка закрывает окно тем же ходом', () => {
  it('документ написан и закоммичен — окно всё равно закрыто', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue(stageTask())
    const PHASE_DIR = `${PROJECT}/.planning/phases/20-nazvanie`
    const tree: Record<string, string[]> = {
      [`${PROJECT}/.planning/phases`]: ['20-nazvanie'],
      [PHASE_DIR]: ['20-01-PLAN.md'],
    }
    const norm = (p: string) => String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    const { deps, calls } = makeDeps({
      adapter,
      clockObj: c,
      deps: {
        fsImpl: {
          existsSync: (p: string) => Object.prototype.hasOwnProperty.call(tree, norm(p)),
          readdirSync: (p: string) => {
            if (!Object.prototype.hasOwnProperty.call(tree, norm(p))) throw new Error(`ENOENT ${norm(p)}`)
            return tree[norm(p)]
          },
          mkdirSync: () => {},
          writeFileSync: () => {},
        },
        execGit: () => 'beef123\n',
      },
    })

    const res = await tick(deps)

    expect(res.completed).toBe('S-1788110314981')
    expect(closes(calls)).toHaveLength(1)
    expect(closes(calls)[0].args).toEqual(['--window-token', SESSION])
  })
})
