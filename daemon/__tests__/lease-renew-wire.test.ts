/**
 * ПРОВОД: ПОТОК СТРОК РАБОТНИКА → ПРОДЛЕНИЕ АРЕНДЫ ЗАДАЧИ.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ И ЧЕГО НЕ ДОКАЗЫВАЛ НИКТО ДО ЭТОГО ФАЙЛА. Рядом уже лежит контракт
 * на живой библиотеке очереди: он загружает НАСТОЯЩИЙ движок, читает исходник бэкенда,
 * выводит список вызванных методов и требует, чтобы продление шло своим запросом к базе. Он
 * закрывает вопрос «умеет ли очередь продлевать». Он НИКАК не отвечает на второй вопрос —
 * «зовёт ли её кто-нибудь, пока работник пишет».
 *
 * Второй вопрос не держал ни один тест из двух с лишним тысяч. Это проверено мутацией, а не
 * прочтением: вызов продления был удалён из обработчика строк, и весь сьют демона остался
 * ЗЕЛЁНЫМ — 62 файла, 2086 пройденных, код выхода 0. Подделка адаптера в соседнем файле
 * несёт `async touch() { return true }` — пустышку без единого счётчика, то есть подделка
 * богаче библиотеки ровно там, где от неё требуется быть беднее.
 *
 * Цена ненаписанного теста известна поимённо. Пока живая попытка не продлевает аренду, очередь
 * считает её брошенной и отдаёт задачу второму процессу: три параллельные сессии на одной
 * задаче, сожжённая подписка и доска, показывающая пустую очередь. Строка вызова стоит в коде
 * ИМЕННО для этого, и до сих пор её держала дисциплина, а не прогон.
 *
 * ТРИ УТВЕРЖДЕНИЯ, И КАЖДОЕ — О ПОЛУЧАТЕЛЕ:
 *
 *   (1) ПРОВОД. Живой тик, живая очередь, поток строк от работника — и продление ПРИШЛО в
 *       адаптер с идентификатором ИМЕННО этой задачи. Утверждается запись, сделанная на
 *       принимающей стороне, а не способность функции продлевать. Отдельным утверждением —
 *       замок от пустоты: тест, в котором строк не случилось, прошёл бы по вакансии и
 *       перестал бы сторожить молча.
 *   (2) ТРОТТЛИНГ. Две строки внутри окна тридцати секунд дают РОВНО ОДНО продление, строка
 *       за окном — второе. Без этого утверждения «продление вызывается» одинаково верно и
 *       для кода, который зовёт его на каждую строку болтливой сессии.
 *   (3) СБОЙ ПРОДЛЕНИЯ НЕ РОНЯЕТ ПОТОК И НЕ МОЛЧИТ. Продление бросает — попытка живёт до
 *       конца, а в её собственном журнале остаётся ОДНА строка о том, что аренда не
 *       продлевается. Один раз за попытку, а не на каждую строку: сломанная аренда говорит
 *       своё слово однажды.
 *
 * ОЧЕРЕДЬ ЗДЕСЬ НАСТОЯЩАЯ. Счётчик — не подделка вместо адаптера, а тонкая обёртка ПОВЕРХ
 * настоящей очереди: она записывает вызов и передаёт его дальше в живую реализацию. Урок этого
 * дерева: подделка, отдающая то, чего от неё ждут, зелена всегда — в том числе в тот день,
 * когда форму ответа знают неправильно.
 */

import { describe, it, expect } from 'vitest'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'

// ── время, которым распоряжается случай ────────────────────────────────────────────────────

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

/** Окно троттлинга, объявленное в тике. Здесь оно записано числом намеренно: тест,
 *  импортирующий константу у испытуемого, согласится с любой её будущей правкой молча. */
const THROTTLE_MS = 30_000

// ── очередь со счётчиком продлений ─────────────────────────────────────────────────────────

type Renewal = { taskId: string; at: number }

/**
 * Настоящая очередь, обёрнутая счётчиком. Продление записывается И передаётся дальше — то
 * есть наблюдение ничего не подменяет: очередь по-прежнему делает свою работу, а тест видит,
 * что именно до неё доехало и в какой момент.
 */
function queueWithLeaseCounter(clock: () => number) {
  const renewals: Renewal[] = []
  const inner = createMemoryQueue({ clock, expireMs: 300_000 })
  const adapter = {
    ...inner,
    async touch(taskId: string) {
      renewals.push({ taskId, at: clock() })
      return inner.touch(taskId)
    },
  }
  return { adapter, renewals, inner }
}

/** Очередь, чьё продление ВСЕГДА срывается — для случая (3). */
function queueWithBrokenLease(clock: () => number) {
  const attempted: string[] = []
  const inner = createMemoryQueue({ clock, expireMs: 300_000 })
  const adapter = {
    ...inner,
    async touch(taskId: string) {
      attempted.push(taskId)
      throw new Error('база аренды недоступна')
    },
  }
  return { adapter, attempted }
}

// ── мир одного тика ────────────────────────────────────────────────────────────────────────

const task = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
  ...over,
})

const CODE_RESPONSES: Record<string, any> = {
  preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
  worktree: { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/x', branch: 'wt/x' }) },
  reverify: { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }) },
}

/**
 * Работник, который пишет строки В НАЗВАННЫЕ МОМЕНТЫ. Пауза перед строкой двигает часы
 * случая — иначе троттлинг нечем измерить: все строки пришли бы в одну миллисекунду.
 */
function streamingWorker(script: Array<{ afterMs?: number; line: string }>, c: { advance: (ms: number) => number }) {
  return (spec: any) => {
    for (const step of script) {
      if (step.afterMs) c.advance(step.afterMs)
      spec.onLine?.(step.line)
    }
    spec.onExit?.({ code: 0, signal: null })
    return { pid: 4242, kill: () => {} }
  }
}

function makeDeps(over: any) {
  const attempts: any[] = []
  const journalled: any[] = []
  const attemptLogLines: any[] = []
  const deps: any = {
    adapter: over.adapter,
    ledger: {
      recordAttempt: (a: any) => {
        attempts.push(a)
        return a
      },
      readAttempts: (id: string) => attempts.filter((x) => x.taskId === id),
      attemptLog: () => ({ append: (e: any) => attemptLogLines.push(e) }),
    },
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
    verbRunner: async (_bin: string, argsArray: string[]) => CODE_RESPONSES[argsArray[1]] ?? { code: 0, stdout: '{}' },
    spawnWorker: over.spawnWorker,
    report: async () => {},
    clock: over.clock,
    journal: (e: any) => journalled.push(e),
  }
  return { deps, attempts, journalled, attemptLogLines }
}

/** Продление улетает отдельным обещанием — дать ему приземлиться, прежде чем читать журнал. */
const settle = () => new Promise((r) => setImmediate(r))

// ── случаи ─────────────────────────────────────────────────────────────────────────────────

describe('ПРОВОД: пока работник пишет, аренда его задачи продлевается', () => {
  it('a line from the worker REACHES the queue as a renewal of THIS task', async () => {
    const c = mkClock()
    const { adapter, renewals } = queueWithLeaseCounter(c.clock)
    await adapter.enqueue(task({ id: 'BL-alive' }))

    const { deps } = makeDeps({
      adapter,
      clock: c.clock,
      spawnWorker: streamingWorker(
        [{ line: 'APPROACH_NOTE: прямой путь' }, { line: 'LESSON_NONE: тестовый работник' }],
        c,
      ),
    })

    await tick(deps)
    await settle()

    // ЗАМОК ОТ ПУСТОТЫ, отдельным утверждением. Случай, в котором до адаптера не доехало
    // НИЧЕГО, прошёл бы все проверки ниже по вакансии и перестал бы сторожить молча.
    expect(renewals.length).toBeGreaterThan(0)

    // И утверждение о получателе: пришёл идентификатор ИМЕННО этой задачи, а не какой-нибудь.
    expect(renewals.map((r) => r.taskId)).toEqual(Array(renewals.length).fill('BL-alive'))
  })

  it('two lines inside the window renew ONCE; a line past it renews again', async () => {
    const c = mkClock()
    const start = c.clock()
    const { adapter, renewals } = queueWithLeaseCounter(c.clock)
    await adapter.enqueue(task({ id: 'BL-chatty' }))

    const { deps } = makeDeps({
      adapter,
      clock: c.clock,
      spawnWorker: streamingWorker(
        [
          // первая строка попытки — окно ещё не открывалось, продление уходит сразу
          { line: 'APPROACH_NOTE: прямой путь' },
          // вторая ВНУТРИ окна — продления быть не должно
          { afterMs: THROTTLE_MS / 3, line: 'stream line' },
          // третья ЗА окном — второе продление
          { afterMs: THROTTLE_MS, line: 'LESSON_NONE: тестовый работник' },
        ],
        c,
      ),
    })

    await tick(deps)
    await settle()

    // Три строки, два продления — не одно на строку и не одно на попытку.
    expect(renewals).toEqual([
      { taskId: 'BL-chatty', at: start },
      { taskId: 'BL-chatty', at: start + THROTTLE_MS / 3 + THROTTLE_MS },
    ])
  })

  it('a renewal that throws does NOT kill the attempt, and leaves ONE line in its journal', async () => {
    const c = mkClock()
    const { adapter, attempted } = queueWithBrokenLease(c.clock)
    await adapter.enqueue(task({ id: 'BL-broken-lease' }))

    const { deps, attemptLogLines } = makeDeps({
      adapter,
      clock: c.clock,
      spawnWorker: streamingWorker(
        [
          { line: 'APPROACH_NOTE: прямой путь' },
          { afterMs: THROTTLE_MS + 1, line: 'stream line' },
          { afterMs: THROTTLE_MS + 1, line: 'LESSON_NONE: тестовый работник' },
        ],
        c,
      ),
    })

    const res = await tick(deps)
    await settle()

    // Fail-open доказан результатом, а не намерением: попытка дошла до своего исхода.
    expect(res.failed?.reason).not.toBe('lease')
    expect(attempted.length).toBeGreaterThan(1) // сорвалось не однажды — окно открывалось трижды

    // ...и молчания нет: ровно одна строка на попытку, сколько бы раз продление ни сорвалось.
    const complaints = attemptLogLines.filter((e: any) => /lease renewal failed/.test(String(e && e.line)))
    expect(complaints).toHaveLength(1)
    expect(String(complaints[0].line)).toContain('база аренды недоступна')
  })
})
