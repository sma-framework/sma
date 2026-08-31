/**
 * Tests for daemon/src/queue/liveness.mjs +
 * daemon/src/queue/cas.mjs (Task 2, CAS lost-race cases live here per the plan).
 *
 * Liveness contract (Paperclip §8 as ТЗ): «every non-terminal task must have a durable
 * live path». The sweep audits DURABLE state only (fake adapter + fake ledger, frozen
 * clocks — no in-memory task registry, no live Postgres):
 *   - queued task → OK (audited, not requeued)
 *   - active + fresh touch → OK
 *   - active + STALE touch → fail(liveness_killed) + attempt row + requeue (attempt+1)
 *   - kill-drill: daemon death mid-task → task back to queued, attempt+1, ledger row
 *   - computeCooldownMs exponential throttle at n=2,3,4,10
 *   - CAS: won on 1 row, LOST (no throw) on 0 rows; claim generation in the WHERE
 */

import { describe, it, expect } from 'vitest'

import { livenessSweep, computeCooldownMs, MAX_ATTEMPT_LIFETIME_MS } from '../src/queue/liveness.mjs'
import { casTransition } from '../src/queue/cas.mjs'
import { FAIL_REASONS, REASON_LABELS } from '../src/queue/adapter.mjs'

const mkClock = (start = 1000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

// ── a minimal fake QueueAdapter: fail() mirrors the pg-boss retry-on-fail semantics
// (requeue the SAME record with attempt+1 while retries remain) AND writes the durable
// attempt row via the injected ledger, exactly as pgboss-backend.fail() does. ──
function makeFakeAdapter({ clock, ledger }: { clock: () => number; ledger?: any }) {
  const now = () => clock()
  const recs = new Map<string, any>()
  return {
    _seed(rec: any) {
      recs.set(rec.id, { ...rec })
    },
    async list() {
      return [...recs.values()].map((r) => ({ ...r }))
    },
    async fail(id: string, reason: string) {
      const r = recs.get(id)
      if (!r) return false
      if (ledger && typeof ledger.recordAttempt === 'function') {
        ledger.recordAttempt({
          taskId: id,
          attempt: r.attempt,
          outcome: 'failed',
          failureReason: reason,
          endedAt: new Date(now()).toISOString(),
        })
      }
      if (r.attempt < (r.maxAttempts ?? 3)) {
        r.status = 'queued' // pg-boss auto-retry: same row back to the queue
        r.attempt += 1
        // A row waiting for a worker holds neither clock: nothing has taken it and nothing is
        // renewing anything.
        r.claimedAt = null
        r.leaseRenewedAt = null
      } else {
        r.status = 'failed'
        r.failure_reason = reason
      }
      return true
    },
    async touch(id: string) {
      const r = recs.get(id)
      if (r && r.status === 'claimed') {
        // A renewal moves the LEASE clock and nothing else — the moment the work was taken is a
        // different fact, and a fake that moved it too would let the sweep read either one.
        r.leaseRenewedAt = now()
        return true
      }
      return false
    },
  }
}

function makeFakeLedger() {
  const rows: any[] = []
  return {
    recordAttempt: (a: any) => {
      rows.push(a)
      return a
    },
    readAttempts: (taskId: string) => rows.filter((r) => r.taskId === taskId),
    _rows: rows,
  }
}

const claimed = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'x',
  lane: 'prod',
  status: 'claimed',
  attempt: 1,
  claimedAt: 1000,
  ...over,
})

describe('livenessSweep — durable live-path audit', () => {
  it('a queued task is a durable live path — audited, never requeued', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ status: 'queued', claimedAt: null }))
    c.advance(500000)
    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(res.audited).toBe(1)
    expect(res.requeued).toBe(0)
    const [row] = await adapter.list()
    expect(row.status).toBe('queued')
  })

  it('an active task with a fresh touch is OK — audited, not requeued', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ claimedAt: 1000 }))
    c.advance(60000) // < expireMs, still fresh
    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(res.audited).toBe(1)
    expect(res.requeued).toBe(0)
    const [row] = await adapter.list()
    expect(row.status).toBe('claimed')
  })

  /**
   * THE SWEEP READS THE RENEWAL CLOCK, NOT THE CLAIM CLOCK. A row now states both facts: when the
   * attempt was taken and when its lease was last renewed. A long attempt is claimed once and
   * renewed every couple of minutes, so measuring its life from the claim would declare it dead
   * WHILE IT RUNS — the sweep kills no process, so the same task would be handed to a second
   * worker and a third, each burning the subscription window, exactly the fault this file exists
   * to prevent. It is asserted here because the two clocks only became separable now: before, the
   * claim clock WAS the renewal clock and either read the same.
   */
  it('an attempt claimed hours ago but renewed a minute ago is alive — measured from the renewal', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ claimedAt: 1000, leaseRenewedAt: 1000 }))
    c.advance(3 * 3600000) // three hours of real work
    await adapter.touch('BL-1') // the tick renews the lease, as it does every couple of minutes
    c.advance(60000) // a minute since the renewal — well inside the lease

    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(res.audited).toBe(1)
    expect(res.requeued).toBe(0) // NOT declared dead while it is running
    const [row] = await adapter.list()
    expect(row.status).toBe('claimed')
  })

  it('terminal tasks (completed/failed) carry no live-path obligation — not audited', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-done', status: 'completed' }))
    adapter._seed(claimed({ id: 'BL-dead', status: 'failed' }))
    c.advance(500000)
    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(res.audited).toBe(0)
    expect(res.requeued).toBe(0)
  })

  it('kill-drill: daemon death mid-task requeues the task with attempt+1 and a liveness_killed attempt row (zero lost state)', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    // A task is claimed and running; then the daemon is KILLED — no complete/fail ever
    // fires, and the touch clock stops. Time advances well past expiry.
    adapter._seed(claimed({ id: 'BL-1', status: 'claimed', attempt: 1, claimedAt: 1000 }))
    c.advance(200000) // past expireMs (120000), no touch — the worker/daemon died

    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })

    const [row] = await adapter.list()
    expect(row.status).toBe('queued') // back in the queue
    expect(row.attempt).toBe(2) // attempt+1
    expect(res.requeued).toBe(1)
    const attempts = ledger.readAttempts('BL-1')
    expect(attempts).toHaveLength(1)
    expect(attempts[0].failureReason).toBe('liveness_killed')
  })

  it('a task with >= 2 prior no-progress attempts is throttled on requeue', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    // two prior failed attempts already on record
    ledger.recordAttempt({ taskId: 'BL-1', attempt: 1, outcome: 'failed', failureReason: 'runtime_offline' })
    ledger.recordAttempt({ taskId: 'BL-1', attempt: 2, outcome: 'failed', failureReason: 'runtime_offline' })
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-1', attempt: 3, claimedAt: 1000, maxAttempts: 9 }))
    c.advance(200000)
    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })
    expect(res.requeued).toBe(1)
    expect(res.throttled).toBe(1) // noProgress = 2 prior + 1 = 3 → cooldown > 0
  })
})

describe('computeCooldownMs — exponential rewake throttle', () => {
  it('is 0 for the first run and grows exponentially, capped at 30 min', () => {
    expect(computeCooldownMs(0)).toBe(0)
    expect(computeCooldownMs(1)).toBe(0)
    expect(computeCooldownMs(2)).toBe(120000)
    expect(computeCooldownMs(3)).toBe(240000)
    expect(computeCooldownMs(4)).toBe(480000)
    expect(computeCooldownMs(10)).toBe(1800000) // capped
  })
})

// ── CAS transition (cas.mjs) — lost-race + claim generation ──
describe('casTransition — lock-free compare-and-set', () => {
  // a recorder execSql: returns a configurable row set, records (sql, params)
  const recorder = (rows: any[]) => {
    const calls: any[] = []
    const fn = async (sql: string, params: any[]) => {
      calls.push({ sql, params })
      return { rows }
    }
    return { fn, calls }
  }

  it('wins on a 1-row UPDATE', async () => {
    const { fn } = recorder([{ id: 'BL-1' }])
    const res = await casTransition(fn, {
      table: 'sma_task_attempts',
      id: 'BL-1',
      from: 'awaiting_approval',
      to: 'returned',
    })
    expect(res.won).toBe(true)
  })

  it('LOSES the race on a 0-row UPDATE — returns {won:false}, never throws', async () => {
    const { fn } = recorder([]) // zero rows = a newer claimer already moved the row
    const res = await casTransition(fn, {
      table: 'sma_task_attempts',
      id: 'BL-1',
      from: 'awaiting_approval',
      to: 'returned',
    })
    expect(res.won).toBe(false)
  })

  it('a stale claimer loses: the claim generation (dispatched_at) is in the WHERE + bound as a param', async () => {
    const { fn, calls } = recorder([])
    await casTransition(fn, {
      table: 'sma_task_attempts',
      id: 'BL-1',
      from: 'awaiting_approval',
      to: 'returned',
      dispatchedAt: '2026-07-17T10:00:00Z',
      extra: { returned_note: 'stale' },
    })
    const { sql, params } = calls[0]
    expect(sql).toMatch(/dispatched_at = \$\d/)
    expect(sql).toMatch(/status = \$\d/)
    expect(sql).toMatch(/RETURNING id/)
    expect(params).toContain('2026-07-17T10:00:00Z') // claim generation bound as a param
    expect(params).toContain('stale') // extra SET value bound too
  })

  it('throws on programmer errors (missing execSql / table / id), not on a lost race', async () => {
    await expect(
      casTransition(undefined as any, { table: 't', id: 1, from: 'a', to: 'b' }),
    ).rejects.toBeInstanceOf(TypeError)
  })
})

/**
 * ═══ СТОРОЖ СМЕРТИ ГОВОРИТ ВСЛУХ ═══════════════════════════════════════════════════════════
 *
 * ПОВОД. Обход объявляет попытку мёртвой и возвращает задачу в очередь, не написав об этом ни
 * одной строки. В день, когда он сработал и перевыдал задачу, в операторском логе о нём нет
 * НИЧЕГО, кроме последствий: `grep -c "liveness"` по логу за целые сутки даёт ноль. Расследование
 * того дня пришлось вести по косвенным уликам — а вопрос «почему оно перезапустилось» стоит
 * ровно одной строки.
 *
 * ЧТО УТВЕРЖДАЕТСЯ. Не «функция умеет писать», а ЧТО ИМЕННО написано и КОГДА: одна строка на
 * КАЖДУЮ объявленную мёртвой попытку, с полями, по которым читатель поймёт решение без чтения
 * кода; ни одной строки на живую и на терминальную; и — отдельно — что журнал не стал условием
 * работы сторожа: шва нет, обход работает как раньше.
 */
describe('сторож смерти пишет строку на каждую объявленную мёртвой попытку', () => {
  it('строка сторожа: протухшая попытка даёт ровно одну запись с полями решения', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ attempt: 3, claimedAt: 1000, leaseRenewedAt: 1000 }))
    ledger.recordAttempt({ taskId: 'BL-1', attempt: 1, outcome: 'failed' })
    ledger.recordAttempt({ taskId: 'BL-1', attempt: 2, outcome: 'failed' })
    c.advance(500000)
    const journal: any[] = []

    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000, journal: (e: any) => journal.push(e) })

    expect(res.requeued).toBe(1)
    const lines = journal.filter((e) => e.type === 'liveness.attempt_dead')
    expect(lines, 'смерть попытки снова осталась событием без записи').toHaveLength(1)
    expect(lines[0]).toMatchObject({
      type: 'liveness.attempt_dead',
      taskId: 'BL-1',
      attempt: 3,
      silentMs: 500000, // сколько прошло с последнего продления аренды
      expireMs: 120000, // объявленный срок
      noProgressRuns: 3, // два безрезультатных прогона на записи плюс этот
    })
    expect(lines[0].cooldownMs).toBe(computeCooldownMs(3)) // назначенное остывание
  })

  it('строка объявления не утверждает убийства — что стало с процессом, говорит ОТДЕЛЬНАЯ строка', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ leaseRenewedAt: 1000 }))
    c.advance(500000)
    const journal: any[] = []

    await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000, journal: (e: any) => journal.push(e) })

    const line = journal.find((e) => e.type === 'liveness.attempt_dead')
    expect(String(line.detail)).toContain('объявлена мёртвой')
    expect(String(line.detail)).toContain('перевыдана')
    expect(String(line.detail)).not.toContain('убит')
  })

  it('живая попытка и терминальная не дают ни одной строки', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-fresh', leaseRenewedAt: 1000 }))
    adapter._seed(claimed({ id: 'BL-done', status: 'completed' }))
    adapter._seed(claimed({ id: 'BL-failed', status: 'failed' }))
    c.advance(60000) // < expireMs — свежая
    const journal: any[] = []

    await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000, journal: (e: any) => journal.push(e) })

    expect(journal.filter((e) => e.type === 'liveness.attempt_dead')).toHaveLength(0)
  })

  it('две протухшие попытки — две строки, по одной на каждую', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-1', leaseRenewedAt: 1000 }))
    adapter._seed(claimed({ id: 'BL-2', leaseRenewedAt: 1000 }))
    c.advance(500000)
    const journal: any[] = []

    await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000, journal: (e: any) => journal.push(e) })

    expect(journal.filter((e) => e.type === 'liveness.attempt_dead').map((e) => e.taskId).sort()).toEqual(['BL-1', 'BL-2'])
  })

  it('без журнала обход работает ровно как раньше — журнал НИКОГДА не становится условием работы сторожа', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ leaseRenewedAt: 1000 }))
    c.advance(500000)

    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })

    expect(res).toEqual({ audited: 1, requeued: 1, throttled: 0, renewed: 0, probeBroken: 0, killUnconfirmed: 0 })
    const [row] = await adapter.list()
    expect(row.status).toBe('queued')
    expect(row.attempt).toBe(2)
  })

  it('сломанный журнал не ломает обход — повествование никогда не стоит задачи', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ leaseRenewedAt: 1000 }))
    c.advance(500000)

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      journal: () => {
        throw new Error('сток журнала недоступен')
      },
    })

    expect(res).toEqual({ audited: 1, requeued: 1, throttled: 0, renewed: 0, probeBroken: 0, killUnconfirmed: 0 })
  })

  it('строка пишется ДО объявления провала — иначе бросок объявления снова оставит лог пустым', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ leaseRenewedAt: 1000 }))
    c.advance(500000)
    const journal: any[] = []
    const throwing = {
      ...adapter,
      fail: async () => {
        throw new Error('объявление провала не удалось')
      },
    }

    await expect(
      livenessSweep({ adapter: throwing, ledger, clock: c.clock, expireMs: 120000, journal: (e: any) => journal.push(e) }),
    ).rejects.toThrow()
    expect(journal.filter((e) => e.type === 'liveness.attempt_dead')).toHaveLength(1)
  })
})

/**
 * ═══ СТОРОЖ УБИВАЕТ, А НЕ ТОЛЬКО ОБЪЯВЛЯЕТ ══════════════════════════════════════════════════
 *
 * ПОВОД. «Мёртвая» попытка до сих пор означала только строку в базе: сторож объявлял смерть,
 * возвращал задачу в очередь и НЕ ТРОГАЛ процесс. Живой ребёнок оставался за спиной закрытой
 * строки, следующий тик заводил ещё одну попытку той же задачи — и параллельные процессы жгли
 * подписку, каждый считая себя единственным.
 *
 * ЧТО УТВЕРЖДАЕТСЯ ЗДЕСЬ. Не «функция умеет звать остановку», а ПОРЯДОК и ЧЕСТНОСТЬ:
 *   - остановка ребёнка случается РАНЬШЕ перевыдачи задачи (утверждается общей лентой вызовов,
 *     а не двумя счётчиками: два счётчика доказали бы только то, что оба вызова были);
 *   - «убили» и «убивать было нечем» — РАЗНЫЕ строки журнала, и вторая никогда не выдаёт себя
 *     за первую;
 *   - реестр ручек — коллаборатор, ровно как журнал: демон, собранный без него, подметает как
 *     прежде, и сломанная остановка не стоит задаче ничего.
 *
 * Реестра живых процессов сам сторож не заводит — это его собственный закон из шапки, и куплен
 * он тем, что демон обязан быть убиваем на любой строке.
 */
describe('сторож живости останавливает ребёнка чужой ручкой', () => {
  /** Минимальная подделка реестра ручек: одна остановка, пишущая в общую ленту. */
  const makeTurns = (answer: any, tape: string[]) => ({
    stop(taskId: string) {
      tape.push(`turns.stop(${taskId})`)
      if (typeof answer === 'function') return answer(taskId)
      return answer
    },
  })

  /** Тот же адаптер, но его перевыдача пишет в ТУ ЖЕ ленту — порядок виден как порядок. */
  const taping = (adapter: any, tape: string[]) => ({
    ...adapter,
    async fail(id: string, reason: string) {
      tape.push(`adapter.fail(${id})`)
      return adapter.fail(id, reason)
    },
  })

  const staleSeed = (clock: () => number, ledger: any) => {
    const adapter = makeFakeAdapter({ clock, ledger })
    adapter._seed(claimed({ id: 'BL-1', attempt: 1, claimedAt: 1000, leaseRenewedAt: 1000 }))
    return adapter
  }

  it('stops the child BEFORE the reissue — порядок утверждается общей лентой вызовов', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const tape: string[] = []
    const adapter = taping(staleSeed(c.clock, ledger), tape)
    c.advance(500000)

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      attemptTurns: makeTurns(true, tape),
    })

    expect(res.requeued).toBe(1)
    // ЛЕНТА, А НЕ ДВА СЧЁТЧИКА: мина именно в последовательности. Строка, помеченная закрытой
    // раньше, чем умер процесс, оставляет живого ребёнка без хозяина.
    expect(tape).toEqual(['turns.stop(BL-1)', 'adapter.fail(BL-1)'])
  })

  it('ручка была — в журнале строка про убийство, и она стоит ДО перевыдачи', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = staleSeed(c.clock, ledger)
    c.advance(500000)
    const journal: any[] = []

    await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      journal: (e: any) => journal.push(e),
      attemptTurns: makeTurns(true, []),
    })

    const killed = journal.filter((e) => e.type === 'liveness.attempt_killed')
    expect(killed, 'убийство снова осталось событием без записи').toHaveLength(1)
    expect(killed[0]).toMatchObject({ taskId: 'BL-1', attempt: 1, killed: true })
    expect(journal.filter((e) => e.type === 'liveness.attempt_orphaned')).toHaveLength(0)
    // объявление смерти — раньше исхода остановки, исход — раньше перевыдачи
    const types = journal.map((e) => e.type)
    expect(types.indexOf('liveness.attempt_dead')).toBeLessThan(types.indexOf('liveness.attempt_killed'))
  })

  it('ручки нет — строка про orphaned, и строки про убийство НЕТ (вторая ветка не выдаёт себя за первую)', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = staleSeed(c.clock, ledger)
    c.advance(500000)
    const journal: any[] = []

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      journal: (e: any) => journal.push(e),
      attemptTurns: makeTurns(false, []),
    })

    expect(res.requeued).toBe(1) // задача всё равно перевыдана
    const orphaned = journal.filter((e) => e.type === 'liveness.attempt_orphaned')
    expect(orphaned).toHaveLength(1)
    expect(orphaned[0]).toMatchObject({ taskId: 'BL-1', killed: false })
    expect(journal.filter((e) => e.type === 'liveness.attempt_killed')).toHaveLength(0)
    expect(String(orphaned[0].detail)).not.toContain('убит')
  })

  it('реестр не подан вовсе — подметание работает как прежде, ни одной новой строки', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = staleSeed(c.clock, ledger)
    c.advance(500000)
    const journal: any[] = []

    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000, journal: (e: any) => journal.push(e) })

    expect(res).toEqual({ audited: 1, requeued: 1, throttled: 0, renewed: 0, probeBroken: 0, killUnconfirmed: 0 })
    expect(journal.filter((e) => e.type === 'liveness.attempt_killed')).toHaveLength(0)
    expect(journal.filter((e) => e.type === 'liveness.attempt_orphaned')).toHaveLength(0)
    expect(journal.filter((e) => e.type === 'liveness.attempt_dead')).toHaveLength(1)
  })

  it('остановка бросила исключение — подметание не упало, задача всё равно перевыдана', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = staleSeed(c.clock, ledger)
    c.advance(500000)
    const journal: any[] = []

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      journal: (e: any) => journal.push(e),
      attemptTurns: {
        stop() {
          throw new Error('реестр ручек недоступен')
        },
      },
    })

    expect(res.requeued).toBe(1)
    const [row] = await adapter.list()
    expect(row.status).toBe('queued')
    // и НИ ОДНОГО утверждения об исходе: что стало с процессом — неизвестно, а выдумывать
    // «убили» или «нечего убивать» значило бы соврать в обе стороны сразу.
    expect(journal.filter((e) => e.type === 'liveness.attempt_killed')).toHaveLength(0)
    expect(journal.filter((e) => e.type === 'liveness.attempt_orphaned')).toHaveLength(0)
  })

  it('живая попытка ручку не дёргает вовсе — сторож не трогает того, кто отвечает', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-fresh', leaseRenewedAt: 1000 }))
    c.advance(60000) // < expireMs
    const tape: string[] = []

    await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000, attemptTurns: makeTurns(true, tape) })

    expect(tape).toEqual([])
  })
})

/**
 * ═══ ИСХОД УБИТОЙ ПОПЫТКИ НАЗЫВАЕТСЯ СВОИМ ИМЕНЕМ ═══════════════════════════════════════════
 *
 * ПОВОД. Приговор сторожа писался словом `runtime_offline`, и красная карточка говорила «среда
 * исполнения недоступна» — про среду, которая всё это время была жива. Молчал РАБОТНИК. Человек
 * читал карточку и шёл чинить машину, с которой ничего не случилось, — ровно та подмена, ради
 * запрета которой в этом словаре вообще проведены границы.
 *
 * ЧТО УТВЕРЖДАЕТСЯ. Не «слово существует», а ПРОВОД: слово, с которым сторож зовёт очередь,
 * доезжает до строки попытки в реестре — и это `liveness_killed`, а НЕ `runtime_offline`.
 * Отдельно — что слово принято закрытым словарём и несёт человеческую подпись: `fail()`
 * бросает на слове, которого не носит, поэтому непризнанный приговор уронил бы весь обход.
 */
describe('приговор сторожа доезжает как liveness_killed, а не runtime_offline', () => {
  it('провод: с чем сторож зовёт очередь, то и лежит в строке попытки', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const inner = makeFakeAdapter({ clock: c.clock, ledger })
    inner._seed(claimed({ id: 'BL-1', attempt: 1, claimedAt: 1000, leaseRenewedAt: 1000 }))
    const reasons: string[] = []
    const adapter = {
      ...inner,
      async fail(id: string, reason: string) {
        reasons.push(reason) // ЧЕМ позвали — половина провода
        return inner.fail(id, reason)
      },
    }
    c.advance(500000) // молчит дольше срока

    const res = await livenessSweep({ adapter, ledger, clock: c.clock, expireMs: 120000 })

    expect(res.requeued).toBe(1)
    expect(reasons).toEqual(['liveness_killed'])
    // ВТОРАЯ половина: то же слово в durable-строке, которую прочитает человек.
    const [row] = ledger.readAttempts('BL-1')
    expect(row.failureReason).toBe('liveness_killed')
    expect(row.failureReason).not.toBe('runtime_offline')
  })

  it('слово признано закрытым словарём и несёт подпись — иначе fail() уронил бы обход', () => {
    expect(FAIL_REASONS).toContain('liveness_killed')
    expect(REASON_LABELS.liveness_killed).toBe('убита сторожем живости: молчала дольше срока')
    // и подпись про среду осталась только у настоящей недоступности среды
    expect(REASON_LABELS.runtime_offline).toBe('среда исполнения недоступна')
    expect(REASON_LABELS.liveness_killed).not.toContain('среда')
  })
})

/**
 * ═══ ОТКАЗ ПРОБЫ — НЕ МОЛЧАНИЕ РАБОТНИКА ════════════════════════════════════════════════════
 *
 * ПОВОД (замерено 31.08.2026). Соседняя работа опустошила склад зависимостей, хелперы перестали
 * запускаться — и проба живости начала БРОСАТЬ. Обход читал бросок как «нечего сказать», шёл
 * судить по часам и трижды подряд похоронил одну и ту же живую попытку словом `liveness_killed`,
 * пока её процесс работал. Разница между «спросить не у кого» и «спросил, и мне сломалось» стоила
 * трёх сгоревших окон и четырёх процессов на одной подписке.
 *
 * ЧТО УТВЕРЖДАЕТСЯ ЗДЕСЬ. Не «есть ещё одно значение», а РЕШЕНИЕ: по несостоявшейся пробе
 * приговор НЕ выносится вовсе — ни строки `attempt_dead`, ни вызова остановки, ни перевыдачи, —
 * и при этом попытка не становится бессмертной: потолок жизни закрывает её своим именем.
 */
describe('сломанная проба живости не даёт приговора', () => {
  /** Реестр, чей пробник БРОСАЕТ: ровно поведение хелпера, под которым исчез склад модулей. */
  const brokenProbe = (tape: string[]) => ({
    alive() {
      throw new Error('пробник не запустился: нет модулей склада')
    },
    stop(taskId: string) {
      tape.push(`turns.stop(${taskId})`)
      return true
    },
  })

  const staleAdapter = (clock: () => number, ledger: any, over: any = {}) => {
    const adapter = makeFakeAdapter({ clock, ledger })
    adapter._seed(claimed({ id: 'BL-1', attempt: 1, claimedAt: 1000, leaseRenewedAt: 1000, ...over }))
    return adapter
  }

  it('проба бросила — попытка НЕ объявлена мёртвой, остановку даже не звали', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = staleAdapter(c.clock, ledger)
    const tape: string[] = []
    const journal: any[] = []
    c.advance(500000) // молчит дольше срока аренды — ровно тот случай, что хоронил живых

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      journal: (e: any) => journal.push(e),
      attemptTurns: brokenProbe(tape),
    })

    // НИ ОДНОГО приговора: ни перевыдачи, ни строки попытки, ни вызова остановки.
    expect(res.requeued, 'по сломанной пробе снова судят по часам — это и есть починяемый дефект').toBe(0)
    expect(res.probeBroken).toBe(1)
    expect(tape, 'остановку звали, хотя про процесс не известно ничего').toEqual([])
    expect(ledger.readAttempts('BL-1')).toHaveLength(0)
    const [row] = await adapter.list()
    expect(row.status).toBe('claimed')
    expect(row.attempt).toBe(1)
    // И СЛОВО СВОЁ: отказ пробы называет себя, а не притворяется молчанием работника.
    expect(journal.filter((e) => e.type === 'liveness.attempt_dead')).toHaveLength(0)
    const said = journal.filter((e) => e.type === 'liveness.probe_unavailable')
    expect(said).toHaveLength(1)
    expect(String(said[0].detail)).toContain('НЕ СОСТОЯЛАСЬ')
  })

  it('и попытка от этого не становится бессмертной — потолок жизни закрывает её своим именем', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = staleAdapter(c.clock, ledger)
    const tape: string[] = []
    c.advance(MAX_ATTEMPT_LIFETIME_MS + 60000) // перевалили ЗА потолок

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      attemptTurns: brokenProbe(tape),
      sleep: async () => {}, // подтверждение гашения не тратит время сьюта
    })

    expect(res.probeBroken).toBe(0)
    expect(res.requeued).toBe(1)
    expect(tape).toEqual(['turns.stop(BL-1)']) // гашение ПЕРВЫМ, как и на всех дорогах приговора
    const [attemptRow] = ledger.readAttempts('BL-1')
    expect(attemptRow.failureReason).toBe('attempt_lifetime_exceeded')
  })
})

/**
 * ═══ «УМЕРЛА ДЛЯ УЧЁТА, ЖИВА ДЛЯ ДЕНЕГ» — ЗАПРЕЩЕНО ═════════════════════════════════════════
 *
 * ПОВОД (то же 31.08). Остановку звали и верили ей на слово: `stop()` отвечает «ручка была и её
 * дёрнули», а не «процесс кончился». Строки закрывались в промежутке между просьбой и смертью —
 * и за каждой закрытой строкой оставалась живая сессия, которую пришлось снимать руками по PID.
 * Доска при этом показывала «мест 4 из 4 занято» и НИ ОДНОЙ идущей задачи: учёт и машина
 * разошлись ровно на этом.
 *
 * ЧТО УТВЕРЖДАЕТСЯ. Пока сторож ВИДИТ процесс живым после остановки, строка не закрывается
 * вовсе — задача не перевыдаётся, строка попытки не пишется, и в журнале стоит своё слово.
 */
describe('строка не закрывается, пока процесс жив', () => {
  it('процесс пережил остановку — задача НЕ перевыдана, и сторож говорит об этом', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-1', attempt: 1, claimedAt: 1000, leaseRenewedAt: 1000 }))
    const journal: any[] = []
    c.advance(MAX_ATTEMPT_LIFETIME_MS + 60000) // за потолком: приговор законен, гашение — нет

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      journal: (e: any) => journal.push(e),
      // Ручка есть, `stop()` отвечает true — а процесс живёт дальше. Ровно то, что видел
      // человек: «дверь сказала killed:true», и четыре работника на машине.
      attemptTurns: { alive: () => true, stop: () => true },
      sleep: async () => {},
    })

    expect(res.killUnconfirmed).toBe(1)
    expect(res.requeued, 'строка закрыта при живом процессе — это «умерла для учёта, жива для денег»').toBe(0)
    expect(ledger.readAttempts('BL-1'), 'написана строка попытки о смерти, которой не было').toHaveLength(0)
    const [row] = await adapter.list()
    expect(row.status).toBe('claimed') // место занято тем, кто его правда занимает
    // И НИ ОДНОГО УТВЕРЖДЕНИЯ О СМЕРТИ В ЖУРНАЛЕ: объявление пишется только там, где его
    // действительно исполнят, иначе лог врёт ровно в том расследовании, ради которого он ведётся.
    expect(journal.filter((e) => e.type === 'liveness.attempt_dead')).toHaveLength(0)
    expect(journal.filter((e) => e.type === 'liveness.attempt_killed')).toHaveLength(0)
    const unconfirmed = journal.filter((e) => e.type === 'liveness.kill_unconfirmed')
    expect(unconfirmed).toHaveLength(1)
    expect(unconfirmed[0]).toMatchObject({ taskId: 'BL-1', reason: 'attempt_lifetime_exceeded' })
  })

  it('процесс кончился после остановки — приговор идёт до конца, и строка закрывается', async () => {
    const c = mkClock(1000)
    const ledger = makeFakeLedger()
    const adapter = makeFakeAdapter({ clock: c.clock, ledger })
    adapter._seed(claimed({ id: 'BL-1', attempt: 1, claimedAt: 1000, leaseRenewedAt: 1000 }))
    const journal: any[] = []
    let live = true
    c.advance(MAX_ATTEMPT_LIFETIME_MS + 60000)

    const res = await livenessSweep({
      adapter,
      ledger,
      clock: c.clock,
      expireMs: 120000,
      journal: (e: any) => journal.push(e),
      attemptTurns: {
        alive: () => live,
        stop: () => {
          live = false // ровно то, чего ждут от остановки: процесса больше нет
          return true
        },
      },
      sleep: async () => {},
    })

    expect(res.killUnconfirmed).toBe(0)
    expect(res.requeued).toBe(1)
    expect(ledger.readAttempts('BL-1')[0].failureReason).toBe('attempt_lifetime_exceeded')
    expect(journal.filter((e) => e.type === 'liveness.attempt_killed')).toHaveLength(1)
  })
})
