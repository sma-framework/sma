/**
 * Tests for daemon/src/queue/adapter.mjs.
 *
 * The QueueAdapter seam — an EXECUTABLE contract any backend (the
 * in-memory reference now, pg-boss next, a file backend later) must pass:
 *   - queueAdapterContractSuite('memory', …) runs the full describe/it block against
 *     createMemoryQueue with an injected fake clock (this is what makes the seam
 *     honest — the pg-boss suite re-runs THIS block against a real backend).
 *   - Direct unit tests below pin the grep-visible invariants in the test file itself:
 *     the NoReceiptError refusal, enqueue coalescing, the DoR gate
 *     (NotReadyError / InvalidStoryPointsError), the forge rule, the
 *     enqueuedAt/claimedAt/completedAt timestamps, and — since completed work is
 *     reported as awaiting approval — that a receipted complete() leaves the row in
 *     `awaiting_approval` with a stats() counter to match.
 *   - Constants: FAIL_REASONS is the 11-reason human taxonomy and
 *     REASON_LABELS carries a RU подпись for every one.
 *   - The `data` envelope: which EXIT GATE a task must pass rides in `data.kind` /
 *     `data.stage`, and the enqueue gate is fail-closed about both — a typo can never
 *     fall through to the other kind's gate.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  writeWaveHold,
  readWaveHolds,
  readWaveParked,
  markWaveParked,
  WAVE_HOLDS_FILE,
} from '../src/queue/wave-holds.mjs'
import {
  createMemoryQueue,
  queueAdapterContractSuite,
  validateTask,
  acceptanceItems,
  withStatedProject,
  TASK_SOURCES,
  TASK_LANES,
  TASK_STATUSES,
  FAIL_REASONS,
  REASON_LABELS,
  NoReceiptError,
  NotReadyError,
  InvalidStoryPointsError,
  InvalidTaskError,
  DEFAULT_EXPIRE_MS,
  resolveExpireMs,
  TASK_CONTEXT_CAP,
} from '../src/queue/adapter.mjs'

// ── the reusable contract suite, run against the in-memory reference backend ──
queueAdapterContractSuite('memory', ({ clock, expireMs }) => createMemoryQueue({ clock, expireMs }))

// ── grep-visible direct invariants (test-file local) ──

const mkClock = (start = 1000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const backlog = (over: any = {}) => ({
  id: 'BL-96',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  attempt: 1,
  storyPoints: 3,
  acceptance: 'green tests + reverify receipt',
  ...over,
})

/**
 * ONE LIVENESS CLOCK. The sweep that requeues a silent worker and the queue's own lease
 * expiry are two mechanisms answering the same question, and they used to read two
 * different values: the config's expiry reached the sweep and never reached the queue,
 * whose lease then always ran on the built-in default. This resolver is the single place
 * that turns a config into that one number, so the two cannot drift apart by construction.
 */
describe('resolveExpireMs — the ONE liveness value both the sweep and the lease read', () => {
  it('a config that names no expiry yields the shipped default', () => {
    expect(resolveExpireMs({})).toBe(DEFAULT_EXPIRE_MS)
    expect(resolveExpireMs(undefined)).toBe(DEFAULT_EXPIRE_MS)
    expect(DEFAULT_EXPIRE_MS).toBe(120000)
  })

  it('an operator value is honoured exactly', () => {
    expect(resolveExpireMs({ expireMs: 300000 })).toBe(300000)
    expect(resolveExpireMs({ expireMs: 1 })).toBe(1)
  })

  /**
   * A hand-edited config is a trust boundary: this number now reaches pg-boss, where it is
   * divided by 1000 and sent as `expireInSeconds`. NaN or a negative would make a lease of
   * nonsense out of a typo, so anything that is not a positive finite number falls back to
   * the default instead of travelling on.
   */
  it('refuses a value that is not a positive finite number and falls back to the default', () => {
    for (const bad of ['5m', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, {}, []]) {
      expect(resolveExpireMs({ expireMs: bad as any }), `expireMs=${String(bad)}`).toBe(DEFAULT_EXPIRE_MS)
    }
  })
})

describe('validateTask — DoR gate + forge', () => {
  it('rejects a backlog task missing storyPoints with NotReadyError', () => {
    expect(() => validateTask(backlog({ storyPoints: undefined }))).toThrow(NotReadyError)
  })

  it('rejects a backlog task missing acceptance with NotReadyError', () => {
    expect(() => validateTask(backlog({ acceptance: undefined }))).toThrow(NotReadyError)
  })

  it('rejects non-Fibonacci storyPoints with InvalidStoryPointsError', () => {
    expect(() => validateTask(backlog({ storyPoints: 4 }))).toThrow(InvalidStoryPointsError)
  })

  it('accepts a roster task WITHOUT storyPoints/acceptance (founder-explicit is exempt)', () => {
    const out = validateTask({ id: 'R-1', source: 'roster', title: 'expedite', lane: 'prod' })
    expect(out.id).toBe('R-1')
    expect(out.priority).toBe(0)
    expect(out.attempt).toBe(1)
  })

  it('requires a forge object iff lane is forge, and forbids it otherwise', () => {
    expect(() =>
      validateTask({ id: 'F-1', source: 'roster', title: 'make agent', lane: 'forge' }),
    ).toThrow(InvalidTaskError)
    const ok = validateTask({
      id: 'F-1',
      source: 'roster',
      title: 'make agent',
      lane: 'forge',
      forge: { kind: 'agent', description: 'parses twitter' },
    })
    expect(ok.forge.kind).toBe('agent')
    expect(() => validateTask(backlog({ forge: { kind: 'agent', description: 'x' } }))).toThrow(InvalidTaskError)
  })

  it('caps title at 200 chars', () => {
    expect(() => validateTask(backlog({ title: 'x'.repeat(201) }))).toThrow(InvalidTaskError)
  })
})

describe('memory backend — receipt refusal, coalescing, timestamps', () => {
  it('complete refuses without a receipt — throws NoReceiptError (no self-certified done)', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    await q.claimNext('w1', {})
    await expect(q.complete('BL-96', { note: 'looks done' })).rejects.toThrow(NoReceiptError)
    await expect(q.complete('BL-96', { receiptRef: 'reverify:abc' })).resolves.toBeTruthy()
  })

  it('enqueue of the same id while pending coalesces to ONE entry with a counter', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    const second = await q.enqueue(backlog())
    expect(second.coalesced).toBe(true)
    expect(second.coalesceCount).toBe(2)
    const rows = await q.list({ status: 'queued' })
    expect(rows).toHaveLength(1)
    expect(rows[0].coalesceCount).toBe(2)
  })

  it('stamps enqueuedAt / claimedAt / completedAt across the transitions', async () => {
    const c = mkClock(5000)
    const q = createMemoryQueue({ clock: c.clock, expireMs: 10000 })
    await q.enqueue(backlog())
    c.advance(100)
    await q.claimNext('w1', {})
    c.advance(100)
    await q.complete('BL-96', { receiptRef: 'reverify:abc' })
    const [row] = await q.list({})
    expect(row.enqueuedAt).toBe(5000)
    expect(row.claimedAt).toBe(5100)
    expect(row.completedAt).toBe(5200)
  })

  /**
   * Completed work is reported as awaiting approval. The receipt is the worker's half of
   * «done»; the other half is a person, and until that word arrives the row says so out
   * loud instead of parking in a status that means the business is finished.
   */
  it('a receipted complete() leaves the row awaiting_approval — never completed', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    await q.claimNext('w1', {})
    await q.complete('BL-96', { receiptRef: 'reverify:abc' })
    const [row] = await q.list({})
    expect(row.status).toBe('awaiting_approval')
    const s = await q.stats()
    expect(s.awaiting_approval).toBe(1)
    expect(s.completed).toBe(0)
  })

  it('stats() carries a key for EVERY status of the closed vocabulary, at zero when empty', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    const s = await q.stats()
    for (const status of TASK_STATUSES) expect(s[status]).toBe(0)
    expect(s.total).toBe(0)
  })

  it('fail(taskId, reason) rejects an unknown reason and records a valid one', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    await q.claimNext('w1', {})
    await expect(q.fail('BL-96', 'not_a_reason')).rejects.toThrow()
    await q.fail('BL-96', 'tests_red')
    const [row] = await q.list({})
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('tests_red')
  })

  /**
   * УПОР В ПОТОЛОК ХОДОВ ПРИНЯТ СЛОВАРЁМ — и это единственное, чем причина становится правдой
   * для ОБОИХ хранилищ сразу: словарь закрыт и проверяется на входе `fail` в каждом из них,
   * поэтому одной записи хватает на всю очередь. Подпись берётся из того же модуля, а не
   * переписывается сюда руками: словарь и его русские подписи обязаны расходиться шумно.
   */
  it('новая причина «упёрся в потолок ходов» принята словарём и имеет русскую подпись', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    await q.claimNext('w1', {})
    await q.fail('BL-96', 'turns_exhausted')
    const [row] = await q.list({})
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('turns_exhausted')
    expect(FAIL_REASONS).toContain('turns_exhausted')
    expect(REASON_LABELS.turns_exhausted).toContain('потолок ходов')
  })

  /**
   * ГРАНИЦА ПОПЫТОК ЖИВЁТ В САМОМ SWEEP, А НЕ В ВЫДАЧЕ — и это свойство именно этого бэкенда.
   *
   * Аренду здесь истекает не библиотека по расписанию, а собственный sweep, и зовут его ТРИ
   * входа: выдача, чтение списка и счётчики. Значит строка, чья граница исчерпана, обязана
   * закрыться и тогда, когда никто больше ничего не просит выдать: человек, просто открывший
   * доску, увидит закрытую строку, а не вечного зомби, ждущего следующей выдачи.
   */
  it('граница попыток исчерпана — строку закрывает сам sweep, даже когда её никто не пытается выдать', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog({ retryLimit: 0 }))
    await q.claimNext('w1', {})
    c.advance(5000) // аренда потеряна, а повторов этой строке не отпущено

    const [row] = await q.list({}) // ни одной выдачи между потерей аренды и этим чтением
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('attempts_exhausted')
    expect(REASON_LABELS.attempts_exhausted).toContain('попытки исчерпаны')
  })

  /**
   * КУСКУ СБОРКИ ГРАНИЦА — НОЛЬ, И ЭТО НЕ НАСТРОЙКА. Кусок, который сломался, обязан
   * ОСТАНОВИТЬ свою сборку и спросить владельца; очередь, тихо запускающая его ещё дважды, —
   * это ровно тот цикл, что стоил дня. У долговременного бэкенда так с того самого дня; здесь
   * то же обещание держит эталон, чтобы оно было свойством контракта, а не одного хранилища.
   */
  it('граница попыток куска сборки — ноль: после первой потерянной аренды он закрыт, а не перевыдан', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog({ id: 'BL-B1', batchId: 'batch-7' })) // границы никто не называл
    await q.claimNext('w1', {})
    c.advance(5000)

    const [row] = await q.list({})
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('attempts_exhausted')
    expect(await q.claimNext('w2', {})).toBeNull()
  })

  /**
   * ГРАНИЦА — ЧИСЛО ИЛИ НИЧЕГО. Она уезжает в предел повторов настоящей очереди, поэтому
   * «две» строкой или отрицательное число сделали бы из опечатки границу, которой никто не
   * писал: у pg-boss `retry_limit` — колонка типа int, и NaN там становится молчаливым нулём
   * или отказом драйвера. Отказ на входе стоит одной понятной ошибки, а пропуск — работы,
   * которая либо не повторится ни разу, либо не остановится никогда.
   */
  it('граница попыток принимается только целым числом от нуля — опечатка отвергается на входе', () => {
    expect(validateTask(backlog({ retryLimit: 0 })).retryLimit).toBe(0)
    expect(validateTask(backlog({ retryLimit: 5 })).retryLimit).toBe(5)
    expect(validateTask(backlog({})).retryLimit).toBeUndefined() // не назвал — не выдумываем
    for (const bad of ['2', -1, 1.5, Number.NaN, null, {}]) {
      expect(() => validateTask(backlog({ retryLimit: bad as any })), `retryLimit=${String(bad)}`).toThrow(
        InvalidTaskError,
      )
    }
  })
})

// ── V5.1: the project field on a task + the read-time backfill ──

describe('project — an additive task field with an injected default', () => {
  it('validateTask accepts an optional project slug and rejects a malformed one', () => {
    expect(validateTask(backlog({ project: 'acme-clinic' })).project).toBe('acme-clinic')
    expect(validateTask(backlog()).project).toBeUndefined()
    expect(() => validateTask(backlog({ project: 'Acme Clinic' }))).toThrow(InvalidTaskError)
    expect(() => validateTask(backlog({ project: 'a'.repeat(65) }))).toThrow(InvalidTaskError)
  })

  it('does NOT check the project against a registry — that is the door\'s job, not the adapter\'s', () => {
    // Structural only: an unknown-but-well-formed slug passes the adapter untouched.
    expect(validateTask(backlog({ project: 'never-registered' })).project).toBe('never-registered')
  })

  it('a task enqueued with no project gets the adapter\'s active project', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000, activeProject: 'acme-clinic' })
    await q.enqueue(backlog())
    const [row] = await q.list({})
    expect(row.project).toBe('acme-clinic')
    const claimed = await q.claimNext('w1', {})
    expect(claimed.project).toBe('acme-clinic')
  })

  it('an explicit project survives the enqueue unchanged', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000, activeProject: 'acme-clinic' })
    await q.enqueue(backlog({ project: 'other-shop' }))
    const [row] = await q.list({})
    expect(row.project).toBe('other-shop')
  })

  it('NOTHING IS FILLED IN ON READ — a row stored before the field existed reads with project: null', async () => {
    // The pure helper is what every read path runs a row through. It used to hand the
    // currently selected project to a row that named none, so the same row belonged to
    // whichever project was being looked at. Now it says what the row says.
    expect(withStatedProject({ id: 'BL-old', lane: 'prod' })).toMatchObject({
      id: 'BL-old',
      project: null,
    })
    expect(withStatedProject({ id: 'BL-old', project: 'acme-clinic' }).project).toBe('acme-clinic')
    expect(withStatedProject(null)).toBeNull()

    // End-to-end: an adapter with NO active project configured stores no project, and every
    // read hands back the absence of the fact rather than a guess at it.
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(backlog())
    const [row] = await q.list({})
    expect(row.project).toBeNull()
    const claimed: any = await q.claimNext('w1', {})
    expect(claimed.project).toBeNull()
  })

  it('list accepts an optional project filter; no filter means every project', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000, activeProject: 'acme-clinic' })
    await q.enqueue(backlog({ id: 'BL-a' }))
    await q.enqueue(backlog({ id: 'BL-b', project: 'other-shop' }))
    expect(await q.list({})).toHaveLength(2)
    expect((await q.list({ project: 'other-shop' })).map((r: any) => r.id)).toEqual(['BL-b'])
    expect((await q.list({ project: 'acme-clinic' })).map((r: any) => r.id)).toEqual(['BL-a'])
    expect(await q.list({ project: 'nobody' })).toHaveLength(0)
  })

  it('lane and project are INDEPENDENT dimensions — a forge task in another project is valid', async () => {
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000, activeProject: 'acme-clinic' })
    await q.enqueue({
      id: 'F-9',
      source: 'roster',
      title: 'make an agent',
      lane: 'forge',
      project: 'other-shop',
      forge: { kind: 'agent', description: 'parses invoices' },
    })
    const [row] = await q.list({ project: 'other-shop' })
    expect(row.lane).toBe('forge')
    expect(row.project).toBe('other-shop')
  })
})

// ── снимок контекста задачи: место человека на строке очереди ──

describe("taskContext — the human's snapshot of what this task is about, living on the queue row", () => {
  const withCtx = (over: any = {}) => backlog({ taskContext: 'счёт-фактуры лежат в /invoices', ...over })

  it('validateTask accepts a taskContext snapshot and keeps it on the normalized task', () => {
    expect(validateTask(withCtx()).taskContext).toBe('счёт-фактуры лежат в /invoices')
    expect(validateTask(backlog()).taskContext).toBeUndefined()
  })

  it('a snapshot over the ceiling is REFUSED, never silently trimmed — they are his words', () => {
    // Trimming a person's own text to fit would hand the worker a sentence that stops
    // mid-thought and tell nobody. The door says no, exactly as it does for every other
    // field of the dictionary.
    expect(TASK_CONTEXT_CAP).toBe(8000)
    expect(validateTask(withCtx({ taskContext: 'д'.repeat(TASK_CONTEXT_CAP) })).taskContext).toHaveLength(
      TASK_CONTEXT_CAP,
    )
    expect(() => validateTask(withCtx({ taskContext: 'д'.repeat(TASK_CONTEXT_CAP + 1) }))).toThrow(InvalidTaskError)
    expect(() => validateTask(withCtx({ taskContext: 42 as any }))).toThrow(InvalidTaskError)
  })

  it('an empty snapshot is an ABSENT snapshot — the row carries no key rather than a blank one', () => {
    // «Поле есть, а текста нет» и «поля нет» читаются вниз по течению по-разному: пустая
    // строка материализовала бы в рабочей копии пустой файл, а в промпте — пустой забор,
    // и оба сказали бы «он ничего не написал» так, будто он писал.
    expect(validateTask(withCtx({ taskContext: '' }))).not.toHaveProperty('taskContext')
    expect(validateTask(withCtx({ taskContext: '   \n  ' }))).not.toHaveProperty('taskContext')
  })

  it('captured task carries taskContext — the wire the rest of the phase hangs on (memory, end to end)', async () => {
    // THE CONTRACT SUITE RUNS THIS WIRE AGAINST BOTH BACKENDS (see adapter.mjs). This local
    // case pins it grep-visibly in the test file and adds the half that is per-backend: the
    // READ SHAPE of the reference queue, checked in the case below.
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(withCtx())
    const claimed: any = await q.claimNext('w1', {})
    expect(claimed.taskContext).toBe('счёт-фактуры лежат в /invoices')
  })

  it('the snapshot is NOT paid for on every poll — the read shape of a row does not carry it', async () => {
    // A row is re-read by the window several times a second; the snapshot is read once per
    // attempt, by the provisioning step and by the card door. Putting it in the list shape
    // would make every poll carry a text sized for a prompt.
    const c = mkClock()
    const q = createMemoryQueue({ clock: c.clock, expireMs: 1000 })
    await q.enqueue(withCtx())
    const [row] = await q.list({})
    expect(row).not.toHaveProperty('taskContext')
  })

  it('widening the task dictionary did NOT unlock unknown keys — both locks still hold', () => {
    // Lock one: the task record is built by explicit pick, so a key nobody allowed never
    // reaches the row. Lock two: the stage envelope is fail-closed and REFUSES outright.
    const norm: any = validateTask(withCtx({ smuggled: 'nope' }))
    expect(norm).not.toHaveProperty('smuggled')
    expect(() => validateTask(withCtx({ data: { kind: 'code', invented: 1 } }))).toThrow(InvalidTaskError)
  })
})

describe('constants — taxonomy', () => {
  it('FAIL_REASONS is the 23-reason human taxonomy and is frozen', () => {
    expect(FAIL_REASONS).toEqual([
      'no_receipt',
      'no_journal',
      // the THIRD condition of a finished attempt: it left neither a lesson nor a word about
      // why there is none. Named apart from no_journal because the two omissions ask a person
      // for different things — the note explains THIS work, the lesson feeds the next one
      'no_lesson',
      // the documentary counterpart of no_receipt: a stage whose product is prose said done
      // and left no document — the file is absent from the phase directory, or uncommitted
      'no_artifact',
      'agent_error',
      // the run the WORKER did not end: the provider cut it (an overload, a server error).
      // Named apart from agent_error because the window used to blame the worker for the
      // vendor's outage, and the two ask a person for opposite things — wait, or fix
      'provider_error',
      // the run the worker did not end EITHER — but this time it was WE who ended it: the
      // attempt walked into the turn ceiling this daemon itself put on the command line. It
      // sits beside provider_error because it asks a person for the same thing an outage does
      // — nothing to fix in the work — and apart from it because the cause is ours, not the
      // vendor's, and the answer is a bigger ceiling or a smaller task
      'turns_exhausted',
      'tests_red',
      'needs_decision',
      'missing_access',
      'timeout',
      'runtime_offline',
      // the watchdog's own verdict on a silent attempt: the lease went unrenewed past the
      // deadline, the sweep stopped the child and handed the task back. Named apart from
      // runtime_offline because that word used to be written over this burial too — «среда
      // исполнения недоступна» about an environment that was alive the whole time, sending a
      // person to check a machine instead of a wedged attempt
      'liveness_killed',
      // THE TWO SPLIT OUT OF liveness_killed THE DAY THE SWEEP GOT A LIVENESS PROBE. While it
      // could only ask the clock, every silence was one event and got one word — and a worker
      // thinking quietly past its lease was buried as a wedge. Now the sweep asks the handle:
      //   worker_process_gone — the handle SAW the child end. A fact, not a verdict on silence,
      //     and it sends the reader to the worker's own log instead of hunting a wedge
      //   attempt_lifetime_exceeded — the process is ALIVE and was stopped anyway: the attempt
      //     outgrew MAX_ATTEMPT_LIFETIME_MS, the one ceiling that keeps «silence is not death»
      //     from becoming «silence is forever». The only reason here that closes running work,
      //     so it must read as neither silence nor crash — the answer is a bigger ceiling or a
      //     smaller task, exactly as with turns_exhausted
      'worker_process_gone',
      'attempt_lifetime_exceeded',
      'window_exhausted',
      // THE FOUR THE DISPATCHER DECIDES BEFORE ANY PROCESS EXISTS. They are named apart from
      // window_exhausted because that one word used to be written over all of them: a person
      // whose own spending ceiling stopped the task was told to wait for a window, and waiting
      // would never have helped him. Each asks for something different — wait, raise the cap,
      // configure the paid channel at all, or nothing (his own working hours are protected)
      'wait_for_window',
      'budget_stop',
      'api_cap_unset',
      'day_priority_protected',
      // the re-issues ran out: the row was handed back as many times as it was allowed to be,
      // and the queue closed it rather than spending another paid attempt on the same work.
      // Named apart from timeout — a lease timing out is what STARTS a re-issue and is
      // survivable — and apart from every worker reason, because nothing is wrong with the work
      'attempts_exhausted',
      // the layer the founder works under could not be put into the account before the spawn.
      // Named apart from every infra cause because it is a REFUSAL and not a breakage: the
      // machine was fine, and the session was simply not allowed to start under rules nobody
      // chose — no instructions, no hooks, and connectors from somewhere else entirely
      'personal_layer_error',
      'manual',
    ])
    expect(Object.isFrozen(FAIL_REASONS)).toBe(true)
  })

  it('REASON_LABELS carries a RU подпись for every FAIL_REASON', () => {
    for (const reason of FAIL_REASONS) {
      expect(typeof REASON_LABELS[reason]).toBe('string')
      expect(REASON_LABELS[reason].length).toBeGreaterThan(0)
    }
  })

  // ── the data envelope: WHICH GATE, carried by the task, refused by name when malformed ──
  //
  // Nothing in the queue interprets these two words; the tick does. What the queue owes them
  // is that they arrive intact and that a typo is refused rather than defaulted: a document
  // stage gated on reverify fails red forever, and a code task gated on an artifact completes
  // without one. Both are silent, and both are prevented here.

  it('the data envelope survives the field allowlist — the gate rides ON the task', () => {
    const out = validateTask({
      id: 'ST-1',
      source: 'roster',
      title: 'спланировать фазу',
      lane: 'paperwork',
      data: { kind: 'document', stage: 'plan', phase: 12 },
    })
    expect(out.data).toEqual({ kind: 'document', stage: 'plan', phase: 12 })
  })

  it('a task with no data envelope is unchanged — absent means «code», today’s behaviour', () => {
    const out = validateTask({ id: 'BL-9', source: 'roster', title: 'обычная задача', lane: 'prod' })
    expect(Object.hasOwn(out, 'data')).toBe(false)
  })

  it('a typo in kind / stage is REFUSED BY NAME, never defaulted to the other gate', () => {
    const base = { id: 'ST-2', source: 'roster', title: 'стадия', lane: 'paperwork' }
    expect(() => validateTask({ ...base, data: { kind: 'documents' } })).toThrow(InvalidTaskError)
    expect(() => validateTask({ ...base, data: { kind: 'document', stage: 'planning' } })).toThrow(/data\.stage/)
    expect(() => validateTask({ ...base, data: { kind: 'document', phase: { n: 12 } } })).toThrow(/data\.phase/)
    expect(() => validateTask({ ...base, data: { kind: 'document', smuggled: 'x' } })).toThrow(/unknown key "smuggled"/)
    expect(() => validateTask({ ...base, data: ['document'] })).toThrow(/must be an object/)
  })

  /**
   * THE WORDS OF A TASK — one field of promise, and the proof that there is only one.
   *
   * The temptation these cases exist against is a second field of «criteria» beside
   * `acceptance`: two places to write the same promise, disagreeing the first time either is
   * edited, with nothing able to say which one the work was judged by. The vocabulary grew by
   * `description` ONLY, and the promise learned a second SHAPE rather than a second home.
   */
  it('the vocabulary grew by description alone — there is no second field of criteria', () => {
    const out = validateTask({
      id: 'R-words',
      source: 'roster',
      title: 'работа со словами',
      lane: 'prod',
      description: 'что это за работа',
      acceptance: ['первый признак', 'второй признак'],
    })
    expect(out.description).toBe('что это за работа')
    expect(out.acceptance).toEqual(['первый признак', 'второй признак'])
    // no neighbouring field of criteria travelled — the promise has exactly one home
    expect(Object.keys(out)).not.toContain('criteria')
    const smuggled: any = validateTask({
      id: 'R-smuggle',
      source: 'roster',
      title: 'работа',
      lane: 'prod',
      criteria: ['так писать нельзя'],
    })
    expect(Object.hasOwn(smuggled, 'criteria')).toBe(false)
  })

  it('acceptanceItems is the ONE reading path: a string is a list of one, blanks are nothing', () => {
    expect(acceptanceItems('тесты зелёные')).toEqual(['тесты зелёные'])
    expect(acceptanceItems(['  первый  ', '', '   ', 'второй'])).toEqual(['первый', 'второй'])
    expect(acceptanceItems(undefined)).toEqual([])
    expect(acceptanceItems('   ')).toEqual([])
    expect(acceptanceItems(42 as any)).toEqual([])
  })

  /** The DoR gate reads THROUGH the normalizer — a promise of nothing is unready in either shape. */
  it('a backlog task promising an EMPTY list is as unready as one promising nothing at all', () => {
    expect(() => validateTask(backlog({ acceptance: [] }))).toThrow(NotReadyError)
    expect(() => validateTask(backlog({ acceptance: ['   '] }))).toThrow(NotReadyError)
    expect(validateTask(backlog({ acceptance: ['зелёные тесты'] })).acceptance).toEqual(['зелёные тесты'])
  })

  it('a criterion that is not a string is refused by name, never coerced', () => {
    expect(() => validateTask(backlog({ acceptance: ['ок', 42] }))).toThrow(/string or a list of strings/)
  })

  it('TASK_LANES includes forge and TASK_SOURCES the three intake origins', () => {
    expect(TASK_LANES).toContain('forge')
    expect(TASK_SOURCES).toEqual(['backlog', 'roster', 'return'])
  })

  it('TASK_STATUSES is the closed five-status vocabulary, waiting-for-a-person included, and is frozen', () => {
    expect(TASK_STATUSES).toEqual(['queued', 'claimed', 'awaiting_approval', 'completed', 'failed'])
    expect(Object.isFrozen(TASK_STATUSES)).toBe(true)
  })
})

/**
 * THE REGISTER OF STOPPED ECHELONS — «останови волну 2» written down rather than remembered.
 *
 * The question worth the most here is the RESTART one, and it is asked the only way it can
 * honestly be asked: a SECOND reader, given nothing but the directory, is asked what is stopped.
 * A store that lived in a process would answer «nothing» — which is exactly how a founder's stop
 * would quietly lift itself in the night and finish the work he had stopped.
 */
describe('wave holds — the register a restart still finds', () => {
  it('an order written by one reader is read back by a fresh one', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wh-'))
    expect(writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'hold' }).ok).toBe(true)

    // nothing is carried over between these two calls but the path itself
    const seen = readWaveHolds({ dataDir })
    expect(seen).toHaveLength(1)
    expect(seen[0].phase).toBe('14')
    expect(seen[0].wave).toBe('2')
    expect(typeof seen[0].since).toBe('number')
  })

  it('lifting is an appended word, not an edit — and the whole story stays readable', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wh-'))
    writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'hold' })
    writeWaveHold({ dataDir, phase: '14', wave: 3, action: 'hold' })
    writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'release' })

    expect(readWaveHolds({ dataDir }).map((h) => h.wave)).toEqual(['3'])
    // the file still tells what happened, in order — three lines, none of them overwritten
    const lines = readFileSync(join(dataDir, WAVE_HOLDS_FILE), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(['hold', 'hold', 'release'])
  })

  it('an order is refused unless it names BOTH halves of an address', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wh-'))
    expect(writeWaveHold({ dataDir, phase: '14', action: 'hold' }).error).toBe('bad address')
    expect(writeWaveHold({ dataDir, phase: '  ', wave: 2, action: 'hold' }).error).toBe('bad address')
    expect(writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'freeze' as any }).error).toBe('bad action')
    expect(readWaveHolds({ dataDir })).toEqual([])
  })

  it('a torn line loses only itself: the orders around it still read', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wh-'))
    writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'hold' })
    appendFileSync(join(dataDir, WAVE_HOLDS_FILE), '{"kind":"hold","phase":"1\n', 'utf8')
    writeWaveHold({ dataDir, phase: '14', wave: 5, action: 'hold' })
    expect(
      readWaveHolds({ dataDir })
        .map((h) => h.wave)
        .sort(),
    ).toEqual(['2', '5'])
  })

  it('the parking is remembered per ORDER: a stop given again is told to the work again', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wh-'))
    writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'hold' })
    markWaveParked({ dataDir, phase: '14', wave: 2, taskIds: ['T-1', 'T-2'] })
    expect(readWaveParked({ dataDir, phase: '14', wave: 2 })).toEqual(['T-1', 'T-2'])
    // another echelon's parking is not this one's
    expect(readWaveParked({ dataDir, phase: '14', wave: 3 })).toEqual([])

    writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'release' })
    writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'hold' })
    expect(readWaveParked({ dataDir, phase: '14', wave: 2 })).toEqual([])
  })

  it('the register says whether the word changed anything at all', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sma-wh-'))
    expect(writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'hold' }).already).toBe(false)
    expect(writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'hold' }).already).toBe(true)
    expect(writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'release' }).already).toBe(false)
    expect(writeWaveHold({ dataDir, phase: '14', wave: 2, action: 'release' }).already).toBe(true)
  })
})
