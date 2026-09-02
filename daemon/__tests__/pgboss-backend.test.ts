/**
 * Tests for daemon/src/queue/pgboss-backend.mjs +
 * daemon/src/queue/attempt-ledger.mjs (Task 2, direct invariants).
 *
 * The pg-boss backend is a certified QueueAdapter: it re-runs the SAME
 * `queueAdapterContractSuite` the in-memory reference passes, here
 * against a STATEFUL FAKE pg-boss (send/fetch/touch/complete/fail/getQueueStats over
 * Maps, honouring singletonKey + priority + expireInSeconds) plus a fake execSql over
 * the same store — jobs AND the daemon's own approval table, so «a live queue with its
 * side table» is a fixture rather than a database. NO live Postgres, NO real pg-boss is
 * ever loaded (boss is injected).
 *
 * Direct grep-visible invariants pinned below:
 *   - every enqueue send carries singletonKey=task.id + expireInSeconds (recorded)
 *   - singletonKey coalescing is observable via the send-call recorder
 *   - complete() without a receiptRef throws NoReceiptError
 *   - start() creates the four lane queues idempotently with a shared deadLetter
 *   - recordAttempt/readAttempts append-and-read the per-task ledger (Task 2)
 *   - completed work is reported as awaiting approval — the approval row joins back onto
 *     the job it belongs to, and stats() counts it out of `completed` rather than twice
 *   - the side table may overrule pg-boss ONLY about finished work, and a decided task
 *     never leaves the contract's closed five-status vocabulary
 *   - fail-open: a database refusing the approval join still answers about the WORK, and
 *     says so once rather than once per poll
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPgBossQueue,
  TASK_QUEUE_LANES,
  DEAD_LETTER_QUEUE,
  BATCH_PARENT_QUEUE,
} from '../src/queue/pgboss-backend.mjs'
import { queueAdapterContractSuite, NoReceiptError } from '../src/queue/adapter.mjs'
import { countTerminalOutcomes, recordAttempt, readAttempts } from '../src/queue/attempt-ledger.mjs'
import { STATE_MACHINE_VERSION, idempotencyKey } from '../src/queue/state-machine.mjs'
import { defaultEnvelope, envelopeHash } from '../src/queue/capability-envelope.mjs'
import { everyKeyTheAnswerMayCarry } from './fixtures/pgboss-real-stats-keys'

// ── temp ledger dirs (cleaned once at the end) ──
const tmpDirs: string[] = []
function mkLedgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sma-ledger-'))
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

// ── a stateful fake pg-boss + a fake execSql over ONE shared job store ──
// Models exactly the pg-boss semantics the backend relies on: singletonKey coalescing,
// priority+FIFO fetch, expireInSeconds expiry (against the INJECTED clock), touch
// keepalive, complete/fail, getQueueStats. The fake execSql reads the same store.
function makeFakeBackend({
  clock,
  expireMs,
  ledgerDir,
}: {
  clock: () => number
  expireMs: number
  ledgerDir?: string
}) {
  const now = () => (typeof clock === 'function' ? clock() : (clock as unknown as number))
  const jobs = new Map<string, any>()
  /**
   * The daemon's OWN approval table, modelled beside the job store: taskId -> {status,
   * returned_note, merge_receipt}. The backend writes it through the same injected execSql
   * it reads it back through, so the fixture is a live queue AND its side table without a
   * Postgres anywhere — which is what lets the contract case «completed work is reported as
   * awaiting approval» run against this backend at all.
   */
  const attempts = new Map<string, any>()
  let seq = 0
  const sendCalls: any[] = []
  const createQueueCalls: any[] = []

  // pg-boss maintenance, simulated: an active job past its expiry goes back into the RETRY
  // state with retry_count+1, or is closed once its re-issues are spent.
  //
  // WHICH WAITING STATE IT LANDS IN IS THE LIBRARY'S ANSWER, NOT A CONVENIENCE. `failJobs`
  // re-inserts the row as `retry`; this fake wrote `created` — a state the library never puts
  // an expired row into — and that one word was enough to hide a live hole, because a
  // resolution that knows only the FIRST waiting state finds the row here and cannot find it on
  // a real database. A fake DIFFERENT from its library is worse than one merely smaller than
  // it: it certifies the difference.
  //
  // AND THE CLOSING OUTPUT IS THE LIBRARY'S TOO. Its expiry plan writes
  // `{"value":{"message":"job timed out"}}` and no `reason` at all; the fake used to invent
  // `reason: 'runtime_offline'`, a field pg-boss writes nowhere, so every reader of a failure
  // cause was measured against a value no real queue has ever produced.
  //
  // THE PAYLOAD SURVIVES THE RE-ISSUE UNTOUCHED, and that is modelled rather than assumed: the
  // library's own re-issue DELETES the row and INSERTS it back with the data copied, so every
  // mark of the try that just ended — the claim time, its try counter, and now the fencing
  // token — lives on until the next claim stamps a new one. Seen on the live queue, where the
  // second worker's claim came back carrying the FIRST worker's marks. A fake that cleared the
  // payload here would be tidier than the library and would certify a fence whose live version
  // has a hole in it: «the old token is gone by itself» is exactly the belief that must not
  // become a test.
  function maintain() {
    const t = now()
    for (const j of jobs.values()) {
      if (j.state === 'active' && j.started_on != null) {
        if (t - j.started_on > j.expireInSeconds * 1000) {
          if ((j.retry_count ?? 0) < (j.retryLimit ?? 2)) {
            j.state = 'retry'
            j.retry_count = (j.retry_count ?? 0) + 1
            j.started_on = null
          } else {
            j.state = 'failed'
            j.output = { value: { message: 'job timed out' } }
          }
        }
      }
    }
  }

  function pendingWithKey(name: string, key: string) {
    for (const j of jobs.values()) {
      if (j.name === name && j.singleton_key === key && (j.state === 'created' || j.state === 'active')) {
        return j
      }
    }
    return null
  }

  const boss = {
    async start() {
      return true
    },
    async stop() {
      return true
    },
    on() {
      /* no-op */
    },
    async createQueue(name: string, opts: any) {
      createQueueCalls.push({ name, opts })
      return true
    },
    async send(name: string, data: any, opts: any = {}) {
      maintain()
      sendCalls.push({ name, data, opts })
      if (opts.singletonKey && pendingWithKey(name, opts.singletonKey)) return null // coalesced
      seq += 1
      const id = `job-${seq}`
      jobs.set(id, {
        id,
        name,
        singleton_key: opts.singletonKey ?? null,
        data,
        priority: opts.priority ?? 0,
        state: 'created',
        retry_count: 0,
        retryLimit: opts.retryLimit ?? 2,
        // WHEN THIS JOB BECOMES FETCHABLE. Modelled because the LIBRARY models it: every fetch
        // plan pg-boss issues carries `AND start_after < now()`, and that column is the whole
        // mechanism «one piece of a batch at a time» rests on. A fake that ignored the option
        // would hand out a held piece and certify a rule the real queue keeps — the fake being
        // richer than its library, once more. (The comparison in `fetch` is `<=` where the
        // library writes `<`: a real database advances its own now() between the INSERT and
        // the later fetch, and this fixture's clock is frozen unless a case moves it. The held
        // value is a date in year 2999, which no comparison of either kind lets through.)
        start_after: opts.startAfter == null ? now() : Date.parse(String(opts.startAfter)),
        expireInSeconds: opts.expireInSeconds ?? 120,
        created_on: now(),
        started_on: null,
        completed_on: null,
        output: null,
      })
      return id
    },
    async fetch(name: string, options: any = {}) {
      maintain()
      const batchSize = options.batchSize ?? 1
      // BOTH WAITING STATES, because the library fetches both: its own plan selects
      // `state < 'active'`, which is `created` AND `retry`. This fake modelled the first one
      // alone — smaller than the library, and therefore allowed — right up until the live
      // queue showed what that blindness hid: a row parked in the retry state after its
      // worker went silent is ordinary waiting work, is handed out like any other, and a
      // suite that could not put a row there could not notice anything about it.
      const avail = [...jobs.values()].filter(
        (j) => j.name === name && (j.state === 'created' || j.state === 'retry') && (j.start_after ?? 0) <= now(),
      )
      avail.sort((a, b) => b.priority - a.priority || a.created_on - b.created_on)
      const picked = avail.slice(0, batchSize)
      for (const j of picked) {
        j.state = 'active'
        j.started_on = now()
      }
      return picked.map((j) => ({
        id: j.id,
        name: j.name,
        data: j.data,
        priority: j.priority,
        retrycount: j.retry_count,
      }))
    },
    // NO `touch` HERE — ON PURPOSE. pg-boss v11 has no touch/renew/heartbeat of any kind,
    // and the fake that used to carry one is exactly why the suite stayed green while the
    // lease renewal threw TypeError on every real tick. A fake may be smaller than the
    // library it stands for; it may never be BIGGER. If a future change calls boss.touch()
    // again, it fails here first instead of in front of the founder.
    async complete(_name: string, id: string, out: any) {
      const j = jobs.get(id)
      if (j) {
        j.state = 'completed'
        j.completed_on = now()
        j.output = out
      }
      return true
    },
    async fail(_name: string, id: string, out: any) {
      const j = jobs.get(id)
      if (j) {
        j.state = 'failed'
        j.output = out
      }
      return true
    },
    // The library really does offer this one (pg-boss v11: cancel(name, id)), and the backend
    // uses it for exactly one thing — taking the pieces of an abandoned batch out of the queue.
    // `cancelled` is a state of pg-boss's own vocabulary, which the backend already maps onto
    // `failed`.
    //
    // WHICH STATES IT REACHES IS READ OFF THE LIBRARY, never guessed: `cancelJobs` in pg-boss's
    // own plans.js updates `WHERE ... AND state < 'completed'` — waiting, retrying AND ACTIVE.
    // This fake modelled `created` alone, which is SMALLER than the library and therefore
    // allowed; it stayed that way only while nothing needed the rest. A piece already under way
    // is cancelled now too, so the fake is corrected to the plan rather than to the need: it may
    // be smaller than pg-boss, never bigger.
    async cancel(_name: string, id: string) {
      const j = jobs.get(id)
      if (j && (j.state === 'created' || j.state === 'retry' || j.state === 'active')) j.state = 'cancelled'
      return true
    },
    // THE LIBRARY'S OWN KEYS, AND NOT ONE MORE. This fake used to answer
    // `{queued, active, completed, failed}` — four names pg-boss has never returned — and the
    // backend asked for exactly those four, so the suite agreed with itself while the live
    // queue answered `undefined` to every one of them and the board printed the zeros that
    // fell out. A fake may be SMALLER than the library it stands for; it may never be BIGGER,
    // and inventing a key is the biggest it can get. The four counts below are the aliases of
    // pg-boss's own statement (`plans.getQueueStats`), computed the way that statement
    // computes them; `singletonsActive` and the queue-row fields it merges in are omitted,
    // which is allowed because it is less.
    //
    // NOTE THAT THERE IS NO `completed` AND NO `failed` HERE, and that is the fact this whole
    // task turned on: the library does not count finished or broken work, so neither may the
    // thing that stands in for it.
    async getQueueStats(name: string) {
      maintain()
      const s: any = { name, deferredCount: 0, queuedCount: 0, activeCount: 0, totalCount: 0 }
      for (const j of jobs.values()) {
        if (j.name !== name) continue
        s.totalCount += 1
        // `deferredCount` filters on the start date alone in the library's plan — no state
        // clause — so a deferred row is ALSO counted in whichever state column it sits in.
        if ((j.start_after ?? 0) > now()) s.deferredCount += 1
        // BOTH WAITING STATES COUNT AS QUEUED, because the library's own stats plan counts
        // `state < 'active'` — created AND retry. A fake counting only the first reports a row
        // handed back after a lost lease as belonging to no column at all, which is exactly how
        // «в очереди» could go on being wrong while every case stayed green.
        if (j.state === 'created' || j.state === 'retry') s.queuedCount += 1
        else if (j.state === 'active') s.activeCount += 1
      }
      return s
    },
  }

  const execSql = async (sql: string, params: any[]) => {
    maintain()
    if (sql.includes('CREATE TABLE')) return { rows: [] }
    if (sql.includes('INSERT INTO sma_task_attempts')) {
      // markAwaitingApproval's upsert: ($1 id, $2 status), the note cleared on re-entry
      const [id, status] = params
      attempts.set(String(id), { ...(attempts.get(String(id)) || {}), status, returned_note: null })
      return { rows: [] }
    }
    if (sql.includes('count(*)') && sql.includes('sma_task_attempts')) {
      // stats()'s separate counter: waiting rows that still have a job to belong to
      const [status] = params
      const live = new Set([...jobs.values()].map((j) => j.data && j.data.id))
      const n = [...attempts.entries()].filter(([id, a]) => a.status === status && live.has(id)).length
      return { rows: [{ n }] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes("SET state = 'created'")) {
      // releaseClaim(): ВЗЯТАЯ СТРОКА ВОЗВРАЩАЕТСЯ В ОЧЕРЕДЬ, И ПОДХОД НЕ СЧИТАЕТСЯ. Смоделирован
      // ровно как написан: по JOB id, только из активного состояния, и — это здесь главное —
      // БЕЗ `retry_count`, потому что именно на нём стоит номер подхода. Подделка, трогающая
      // счётчик, удостоверяла бы возврат, который на живой очереди сжигал бы подход.
      //
      // СТОИТ ВЫШЕ ДВУХ ВЕТОК, ЧЬИ ПРИЗНАКИ ЭТОТ ОПЕРАТОР РАЗДЕЛЯЕТ: имени работника (он его
      // СНИМАЕТ, а не пишет) и отметки аренды. Поставленная ниже, она бы до него не доехала —
      // и возврат молча превратился бы в назначение работника.
      //
      // ОТСРОЧКА МОДЕЛИРУЕТСЯ ЧЕСТНО, потому что ради неё оператор и трогает `start_after`:
      // выборка выше уже отказывает строке, чей срок не вышел (`AND start_after < now()` — это
      // собственный план библиотеки), так что подделка, игнорирующая секунды, удостоверяла бы
      // отсрочку, которой на живой очереди нет. Счёт возвратов — второе, что пишет оператор.
      const jobId = params[0]
      const deferSec = Number(params[1]) || 0
      const j = jobs.get(String(jobId))
      if (j && j.state === 'active') {
        j.state = 'created'
        j.started_on = null
        j.start_after = now() + deferSec * 1000
        const kept: any = {}
        for (const [k, v] of Object.entries(j.data || {})) {
          if (k === 'workerId' || k === 'attemptToken' || k === 'claimedAt' || k === 'claimedAtRetry') continue
          kept[k] = v
        }
        kept.releaseCount = (Number(kept.releaseCount) || 0) + 1
        j.data = kept
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('workerId')) {
      // assignWorker(): the executing worker written into the job payload, keyed by JOB id.
      const [jobId, workerId] = params
      const j = jobs.get(String(jobId))
      if (j && j.state === 'active') j.data = { ...(j.data || {}), workerId }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes("SET state = 'completed'")) {
      // ПОЗДНЯЯ ПРАВДА: строку, которую сторож живости вернул в очередь, закрывает не
      // библиотека — её собственный план правит только АКТИВНЫЕ строки и промолчал бы, — а
      // свой оператор бэкенда. Смоделирован ровно как написан: по JOB id и только в тех двух
      // состояниях ожидания, в которых строку нашли. Стоит ВЫШЕ ветки слов, чей префикс и
      // чей `$2::jsonb` этот оператор разделяет: иначе правда о завершении приехала бы в
      // задание как заплатка к его словам.
      const [jobId, output] = params
      const j = jobs.get(String(jobId))
      if (j && (j.state === 'created' || j.state === 'retry')) {
        j.state = 'completed'
        j.completed_on = now()
        j.output = JSON.parse(String(output))
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('$2::jsonb')) {
      // setWords(): the words of a task MERGED into the job payload, keyed by JOB id — the
      // same shape assignWorker uses. Modelled as a MERGE and not as a replacement, because
      // that is what `data || $2::jsonb` does: a patch naming one field leaves the other
      // exactly as it was, and a fake that replaced would certify an erasure nobody wrote.
      const [jobId, patch] = params
      const j = jobs.get(String(jobId))
      if (j) j.data = { ...(j.data || {}), ...JSON.parse(String(patch)) }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('claimedAt')) {
      // The claim-time stamp: written into the job payload, ONCE PER ATTEMPT. Modelled exactly
      // as the statement is written — keyed by JOB id, scoped to active rows, and refusing to
      // move a value that already belongs to the attempt in flight (the queue's own retry_count
      // is what tells the two apart). A fake looser than its statement would let a renewal move
      // the clock here and stay green.
      //
      // THE FENCING TOKEN RIDES THE SAME STATEMENT, and is modelled with the same guard rather
      // than with a convenience of its own: it is written when — and only when — the claim time
      // beside it is written, which is what makes «a new token per hand-out» a property of one
      // statement instead of a second promise. The RETURNING clause is modelled too, because
      // the backend READS IT BACK: a fake that answered with no rows would send the backend
      // down its «the write did not land» path on every claim, and the suite would certify a
      // token nobody ever hands out.
      const [jobId, claimedAt, attemptToken] = params
      const j = jobs.get(String(jobId))
      if (j && j.state === 'active') {
        const d = j.data || {}
        const retry = j.retry_count ?? 0
        const sameAttempt = d.claimedAt != null && String(d.claimedAtRetry) === String(retry)
        if (!sameAttempt) {
          j.data = { ...d, claimedAt, claimedAtRetry: retry, attemptToken }
          // RETURNING sees the row AS UPDATED — the value just written, not the one before it.
          return { rows: [{ attempt_token: j.data.attemptToken }] }
        }
      }
      // The guard matched nothing: no row was updated, so the statement returns none. A fake
      // that answered here anyway would be more generous than the UPDATE it stands for.
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('start_after = $2')) {
      // applyWaveHolds(): a waiting row of a STOPPED echelon is deferred out of every worker's
      // reach. Modelled with the statement's own guards — keyed by TASK id, only a waiting row,
      // and only one that is currently REACHABLE (so a second pass changes nothing, and a row a
      // batch is already holding is not restamped).
      const [taskId, until] = params
      for (const j of jobs.values()) {
        if (j.data && j.data.id === taskId && j.state === 'created' && (j.start_after ?? 0) <= now()) {
          j.start_after = Date.parse(String(until))
        }
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('start_after = now()')) {
      // releaseBatchTurns(): the piece whose turn has come stops being deferred. Modelled with
      // the statement's own guards — keyed by TASK id, only a waiting row, and only one that is
      // actually held (so a second pass over an already-released piece changes nothing).
      //
      // …И ПОЛ, КОГДА ОПЕРАТОР ЕГО НАЗВАЛ. Два правила снимают удержание этим же заявлением, но
      // снимают РАЗНОЕ: черёд партии отпускает всё отложенное, а волна и занятые файлы — только
      // свою далёкую дату (`start_after >= $2`). Подделка, отпускавшая всё подряд, была щедрее
      // собственного оператора и отменяла ЧУЖУЮ выдержку — короткую отсрочку возвращённой
      // строки, — то есть удостоверяла карусель, которой на живой очереди нет.
      const [taskId, floor] = params
      const floorMs = floor == null ? null : Date.parse(String(floor))
      for (const j of jobs.values()) {
        if (!j.data || j.data.id !== taskId || j.state !== 'created') continue
        const at = j.start_after ?? 0
        if (floorMs == null ? at > now() : at >= floorMs) j.start_after = now()
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes("'{data,skipped}'")) {
      // resolveBatch({skip}): the owner's word appended to the request row's own payload.
      const [batchId, itemId] = params
      for (const j of jobs.values()) {
        if (!j.data || j.data.id !== batchId || j.name !== 'sma.batch') continue
        const env = { ...(j.data.data || {}) }
        env.skipped = [...(Array.isArray(env.skipped) ? env.skipped : []), itemId]
        j.data = { ...j.data, data: env }
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes("'{data,cancelled}'")) {
      const [batchId] = params
      for (const j of jobs.values()) {
        if (!j.data || j.data.id !== batchId || j.name !== 'sma.batch') continue
        j.data = { ...j.data, data: { ...(j.data.data || {}), cancelled: true } }
      }
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('SET output =')) {
      // resolveBatch({cancel}): WHY a cancelled piece is closed, merged into the job's own
      // output — the field every reader already takes a finished row's cause from. Modelled as
      // a MERGE, exactly as `coalesce(output,'{}') || jsonb_build_object(...)` behaves, and
      // keyed by JOB id like every other statement of this backend.
      const [jobId, reason] = params
      const j = jobs.get(String(jobId))
      if (j) j.output = { ...(j.output || {}), reason }
      return { rows: [] }
    }
    if (sql.startsWith('SELECT data, retry_count, state')) {
      // reissue(): ПОСЛЕДНЯЯ строка этой задачи, в каком бы состоянии она ни была — по ней дверь
      // и решает, есть ли что повторять. Смоделирована как написана: по TASK id, самая поздняя
      // одна. Разрыв ничьей по номеру джоба — не вольность фикстуры, а модель настоящей базы:
      // там `created_on` ставится своим now() на каждую вставку и у двух строк не совпадает, а
      // здесь часы стоят, пока их не двинет дело, и без разрыва «последней» оказалась бы первая.
      const taskId = params[0]
      const seqOf = (j: any) => Number(String(j.id).replace('job-', '')) || 0
      const match = [...jobs.values()]
        .filter((j) => j.data && j.data.id === taskId)
        .sort((a, b) => (b.created_on ?? 0) - (a.created_on ?? 0) || seqOf(b) - seqOf(a))[0]
      return { rows: match ? [{ data: match.data, retry_count: match.retry_count, state: match.state }] : [] }
    }
    if (sql.includes("state IN ('created','retry')") && sql.startsWith('SELECT id, name')) {
      // resolveStoppableJob(): the job WAITING to be handed out, in EITHER state this queue
      // waits in. Modelled as the statement is written, and the retry state is modelled with
      // it: it is a real state of the library — a row the liveness sweep handed back, parked
      // until its backoff runs out — and a fake that answered only about the first waiting
      // state would be smaller than the statement in exactly the place the live queue proved
      // it matters. Matched BEFORE the created-only resolution below, whose `SELECT id, name`
      // prefix this statement shares.
      const taskId = params[0]
      const match = [...jobs.values()]
        .filter((j) => (j.state === 'created' || j.state === 'retry') && j.data && j.data.id === taskId)
        .sort((a, b) => (b.created_on ?? 0) - (a.created_on ?? 0))[0]
      return { rows: match ? [{ id: match.id, name: match.name }] : [] }
    }
    // NO CREATED-ONLY RESOLUTION IS MODELLED, because the backend no longer issues one: every
    // door that asks this queue for a waiting row now asks about BOTH states it waits in. A
    // fake that went on answering a statement nobody sends would be a fixture for code that
    // does not exist — and the branch above, which shares its `SELECT id, name` prefix, would
    // be the only thing keeping it from answering the wrong question.
    if (sql.startsWith('UPDATE pgboss.job') && sql.includes('started_on')) {
      // touch(): the lease restamp. Keyed by JOB id (params[0]), not task id, and scoped to
      // active rows — the same shape the backend sends. Must be matched BEFORE the
      // active-job SELECT below, whose `state = 'active'` substring this statement shares.
      const jobId = params[0]
      const j = jobs.get(String(jobId))
      if (j && j.state === 'active') j.started_on = now()
      return { rows: [] }
    }
    if (sql.includes("state = 'active'")) {
      // taskId → active job resolution (touch/complete/fail). `data` and `retry_count` come
      // back as well (2026-08-05): the backend's SELECT asks for them so complete/fail can
      // stamp the attempt row with the number and the lane THE QUEUE holds, and a fake that
      // withheld the two columns would test the absent-value path forever.
      const taskId = params[0]
      const match = [...jobs.values()]
        .filter((j) => j.state === 'active' && j.data && j.data.id === taskId)
        .sort((a, b) => (b.started_on ?? 0) - (a.started_on ?? 0))[0]
      return {
        rows: match ? [{ id: match.id, name: match.name, data: match.data, retry_count: match.retry_count }] : [],
      }
    }
    // list(): the jobs OF THE NAMED QUEUES, LEFT JOINed onto the approval table on the key the
    // live database confirmed — the approval row's id IS the task id the job payload carries.
    //
    // THE `WHERE j.name = ANY($1)` IS MODELLED, not ignored. A fake that answered with every
    // job whatever was asked for would be more generous than the statement it stands for — the
    // exact fault that let a missing method sit green for a release — and it would in
    // particular certify a list() that never asks for the batch queue.
    const withApproval = sql.includes('sma_task_attempts')
    const wanted: string[] | null = Array.isArray(params?.[0]) ? (params[0] as string[]) : null
    return {
      rows: [...jobs.values()]
        .filter((j) => !wanted || wanted.includes(j.name))
        .map((j) => {
          const a = (j.data && attempts.get(j.data.id)) || null
          return {
            id: j.id,
            name: j.name,
            priority: j.priority,
            data: j.data,
            state: j.state,
            retry_count: j.retry_count,
            created_on: j.created_on,
            started_on: j.started_on,
            completed_on: j.completed_on,
            output: j.output,
            ...(withApproval
              ? {
                  approval_status: a ? a.status : null,
                  returned_note: a ? a.returned_note : null,
                  merge_receipt: a ? a.merge_receipt : null,
                }
              : {}),
          }
        }),
    }
  }

  const adapter = createPgBossQueue({ boss, execSql, clock, expireMs, ledgerDir })
  return { adapter, boss, execSql, sendCalls, createQueueCalls, jobs, attempts }
}

// ── the reusable contract suite, run against the pg-boss backend (DI fake boss) ──
queueAdapterContractSuite('pgboss', ({ clock, expireMs }: any) =>
  makeFakeBackend({ clock, expireMs, ledgerDir: mkLedgerDir() }).adapter,
)

// ── pg-boss-specific direct invariants ──

const mkClock = (start = 1000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const backlog = (over: any = {}) => ({
  id: 'BL-196',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  attempt: 1,
  storyPoints: 3,
  acceptance: 'green targeted tests + reverify receipt',
  ...over,
})

/**
 * THE SECOND WAITING STATE — the one only this backend has, and the one a person cannot tell
 * apart from the first.
 *
 * The queue parks a row it handed back in its RETRY state until the backoff runs out, and that
 * is what the liveness sweep produces every time a worker goes silent. Our read path already
 * calls it «в очереди», so a board shows ordinary waiting work — but the stop resolved only the
 * FIRST waiting state, answered «no such task», left the row live, and the very next hand-out
 * gave that work to a worker. Measured on the live queue against the real library, not reasoned
 * about here: this case is the suite's half of that finding.
 */
describe('pg-boss backend — stopping work that is waiting after a lost attempt', () => {
  it('a row parked in the RETRY state is stopped like any other waiting row — and stops being handed out', async () => {
    const c = mkClock()
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())

    // The state the real queue produces constantly: the row was handed back and waits for its
    // next try. Written here by hand rather than through the fixture's own maintenance, so the
    // case says exactly which state it is about — and keeps saying it if the maintenance changes.
    const job = [...jobs.values()][0]
    job.state = 'retry'
    job.retry_count = 1

    // What a person sees is ordinary waiting work — and what the queue does is hand it out.
    expect((await adapter.list({})).find((r: any) => r.id === 'BL-196').status).toBe('queued')

    expect(await adapter.cancelTask('BL-196')).toBe(true)

    expect(job.state).toBe('cancelled')
    expect(job.output.reason).toBe('manual')
    expect(await adapter.claimNext('w1', {})).toBeNull()
  })

  /**
   * И ДВЕРЬ СЛОВ ДОСТАЁТ ДО ТОЙ ЖЕ СТРОКИ — своим решением, а не заодно с остановкой.
   *
   * Остановка научилась видеть оба состояния ожидания раньше, и тогда же было сказано вслух:
   * дотягиваются ли до такой строки ОСТАЛЬНЫЕ обещания — вопрос отдельный, которому положено
   * своё решение и своё дело. Вот оно. Строка стоит именно во ВТОРОМ состоянии ожидания —
   * состоянии, которого у памятного бэкенда нет и быть не может, — и дверь слов обязана её
   * найти: иначе она отвечает «нет такой задачи» о работе, которую доска показывает в очереди.
   */
  it('дверь слов находит строку во ВТОРОМ состоянии ожидания — и следующая выдача несёт новые слова', async () => {
    const c = mkClock()
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog({ description: 'первая редакция' }))

    const job = [...jobs.values()][0]
    job.state = 'retry'
    job.retry_count = 1

    expect((await adapter.list({})).find((r: any) => r.id === 'BL-196').status).toBe('queued')

    expect(await adapter.setWords('BL-196', { description: 'вторая редакция' })).toBe(true)
    expect(job.data.description).toBe('вторая редакция')

    const claimed: any = await adapter.claimNext('w1', {})
    expect(claimed.id).toBe('BL-196')
    expect(claimed.description).toBe('вторая редакция')
  })

  /**
   * И РЕШЕНИЕ ВЛАДЕЛЬЦА ПО ОСТАНОВЛЕННОЙ СБОРКЕ — тоже своим решением, тоже со своим делом.
   *
   * Кусок стоит именно во ВТОРОМ состоянии ожидания. Читающий путь называет его «в очереди»,
   * ветка отмены берёт из очереди всё «в очереди» — и до этого куска не доставала, потому что
   * искала его только в первом состоянии. Результат ровно тот, ради которого отмену и писали
   * наоборот: задержка повтора кончается, и работа брошенной сборки уходит работнику.
   */
  it('отмена сборки достаёт кусок из ВТОРОГО состояния ожидания — и он перестаёт быть выдаваемым', async () => {
    const c = mkClock()
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue({ id: 'B-17', source: 'roster', title: 'сборка', lane: 'prod', batchId: 'B-17', data: { batch: 'parent' } })
    await adapter.enqueue({ id: 'B-17-1', source: 'roster', title: 'кусок 1', lane: 'prod', batchId: 'B-17' })

    const piece = [...jobs.values()].find((j: any) => j.data && j.data.id === 'B-17-1')
    piece.state = 'retry'
    piece.retry_count = 1
    piece.start_after = c.clock() // задержка повтора кончилась: очередь готова его выдать

    expect((await adapter.list({})).find((r: any) => r.id === 'B-17-1').status).toBe('queued')

    expect(await adapter.resolveBatch('B-17', { cancel: true })).toBe(true)

    expect(piece.state).toBe('cancelled')
    expect(piece.output.reason).toBe('manual')
    expect(await adapter.claimNext('w1', {})).toBeNull()
  })

  /**
   * А КУСОК, КОТОРОГО ОТМЕНА НЕ НАШЛА, БОЛЬШЕ НЕ ПРОПАДАЕТ МОЛЧА.
   *
   * Между чтением списка и изъятием строка может уйти: другой демон её выдал, аренда истекла,
   * человек её закрыл. Раньше такой кусок просто пропускался одной строкой `continue` — и
   * отмена возвращала «сделано», не сделав. Здесь промах устроен нарочно: резолвер обоих
   * состояний отвечает пустотой ровно про этот кусок, — и отмена обязана СКАЗАТЬ о нём.
   */
  it('кусок, которого отмена не нашла, называется вслух — молчаливого пропуска больше нет', async () => {
    const c = mkClock()
    const { boss, execSql, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    const lines: string[] = []
    const blind = async (sql: string, params: any[]) => {
      if (sql.includes("state IN ('created','retry')") && params[0] === 'B-18-1') return { rows: [] }
      return execSql(sql, params)
    }
    const adapter = createPgBossQueue({
      boss,
      execSql: blind,
      clock: c.clock,
      expireMs: 5000,
      log: (line: string) => lines.push(line),
    })
    await adapter.enqueue({ id: 'B-18', source: 'roster', title: 'сборка', lane: 'prod', batchId: 'B-18', data: { batch: 'parent' } })
    await adapter.enqueue({ id: 'B-18-1', source: 'roster', title: 'кусок 1', lane: 'prod', batchId: 'B-18' })

    expect(await adapter.resolveBatch('B-18', { cancel: true })).toBe(true)

    const piece = [...jobs.values()].find((j: any) => j.data && j.data.id === 'B-18-1')
    expect(piece.state).not.toBe('cancelled') // изъять его действительно не удалось
    expect(lines.some((l) => l.includes('B-18-1'))).toBe(true) // и об этом сказано
  })
})

/**
 * ПОЗДНЯЯ ПРАВДА О СТРОКЕ, КОТОРУЮ УЖЕ ЗАБРАЛ СТОРОЖ.
 *
 * Между захватом задачи и её закрытием стоит сторож живости: он объявляет замолчавшего
 * мёртвым и возвращает задачу в очередь. Работник при этом мог не молчать, а не успеть
 * сказать — и его завершение с квитанцией приезжает к строке, которой уже распорядились. Дверь
 * завершения адресуется АКТИВНОЙ строке и отвечала «нет такой активной задачи», после чего
 * зелёная работа хоронилась под исходом, реконструированным по молчанию.
 *
 * СТРОКА ЗДЕСЬ ПАРКУЕТСЯ СОБСТВЕННЫМ СРОКОМ БИБЛИОТЕКИ, а не вызовом сторожа: у этой подделки
 * `fail` закрывает строку, тогда как живая библиотека возвращает её в состояние ожидания —
 * ровно то, в которое её кладёт истёкшая аренда. Состояние поэтому берётся у того пути,
 * который подделка моделирует правдиво.
 */
describe('pg-boss backend — правда завершения, пришедшая после приговора сторожа', () => {
  it('строку, вернувшуюся в очередь, закрывает НАЗВАННОЕ позднее завершение — и только оно', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    await adapter.enqueue(backlog())
    const claimed: any = await adapter.claimNext('w1', {})
    expect(claimed.id).toBe('BL-196')

    // Аренда потеряна — строка ждёт следующей попытки. Человек видит обычную работу в очереди.
    c.advance(6000)
    expect((await adapter.list({})).find((r: any) => r.id === 'BL-196').status).toBe('queued')

    // СЕГОДНЯШНИЙ ОТВЕТ ОСТАВЛЕН НА МЕСТЕ: неназванное завершение по-прежнему адресуется
    // активной строке, которой нет. Ни одна другая дорога в новую ветку не заезжает.
    await expect(
      adapter.complete('BL-196', { receiptRef: 'reverify:abc', attemptToken: claimed.attemptToken }),
    ).rejects.toThrow(/no active task/)

    // А названное — закрывает строку правдой завершения.
    expect(
      await adapter.complete('BL-196', {
        receiptRef: 'reverify:abc',
        workerId: 'w1',
        attemptToken: claimed.attemptToken,
        afterSweep: true,
      }),
    ).toBe(true)

    // Работа сделана и ждёт слова человека — и в очередь её больше никто не выдаст.
    expect((await adapter.list({})).find((r: any) => r.id === 'BL-196').status).toBe('awaiting_approval')
    expect(await adapter.claimNext('w2', {})).toBeNull()

    // В реестре попыток — завершение с квитанцией, и БЕЗ выдуманного перехода: активной строки
    // не было, а пары «вернулась в очередь → произведено» контракт состояний не объявляет.
    const rows = readAttempts(ledgerDir, 'BL-196')
    expect(rows.map((r: any) => r.outcome)).toEqual(['completed'])
    expect(rows[0].receiptRef).toBe('reverify:abc')
    expect(Object.hasOwn(rows[0], 'idempotencyKey')).toBe(false)
  })
})

describe('pg-boss backend — job-option contract', () => {
  it('every enqueue sends with singletonKey=task.id, expireInSeconds (from expireMs), retryLimit, to the lane queue', async () => {
    const c = mkClock()
    const { adapter, sendCalls } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    await adapter.enqueue(backlog())
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].name).toBe('sma.task.prod')
    expect(sendCalls[0].opts.singletonKey).toBe('BL-196')
    expect(sendCalls[0].opts.expireInSeconds).toBe(5) // ceil(5000/1000)
    expect(sendCalls[0].opts.retryLimit).toBe(2)
    expect(sendCalls[0].opts.retryBackoff).toBe(true)
  })

  /**
   * ГРАНИЦА ПОПЫТОК ДОЕЗЖАЕТ ДО КОЛОНКИ БИБЛИОТЕКИ — дело про ПРОВОД, а не про вычисление.
   *
   * Решение «сколько раз перевыдавать» принимается теперь одним именем на оба бэкенда, и это
   * значит ровно одно: число обязано оказаться В АРГУМЕНТАХ ПОСЕВА. Резолвер, который считает
   * правильную границу и никуда её не передаёт, оставил бы живую очередь на умолчании
   * библиотеки — тот самый класс, которым эта работа уже платила дважды.
   */
  it('граница попыток уезжает в посев тем числом, которое назвал контракт: своим, нулём у куска сборки, умолчанием иначе', async () => {
    const c = mkClock()
    const { adapter, sendCalls } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    await adapter.enqueue(backlog({ id: 'BL-R0', retryLimit: 0 }))
    await adapter.enqueue(backlog({ id: 'BL-R7', retryLimit: 7 }))
    await adapter.enqueue(backlog({ id: 'BL-RB', batchId: 'batch-9' })) // кусок сборки
    await adapter.enqueue(backlog({ id: 'BL-RD' })) // границы никто не называл

    expect(sendCalls.map((s: any) => s.opts.retryLimit)).toEqual([0, 7, 0, 2])
  })

  it('default expireMs maps to expireInSeconds 120 (the plan default)', async () => {
    const c = mkClock()
    const { adapter, sendCalls } = makeFakeBackend({ clock: c.clock, expireMs: 120000 })
    await adapter.enqueue(backlog())
    expect(sendCalls[0].opts.expireInSeconds).toBe(120)
  })

  it('singletonKey coalescing is observable: the second send returns null (coalesced) — one job, counter bumps', async () => {
    const c = mkClock()
    const { adapter, sendCalls, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    const first = await adapter.enqueue(backlog())
    const second = await adapter.enqueue(backlog())
    expect(first.coalesced).toBe(false)
    expect(second.coalesced).toBe(true)
    expect(second.coalesceCount).toBe(2)
    expect(sendCalls).toHaveLength(2) // both sends attempted
    expect(jobs.size).toBe(1) // but only ONE job row exists
  })

  it('complete without a receiptRef throws NoReceiptError and does not mutate the job', async () => {
    const c = mkClock()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await expect(adapter.complete('BL-196', {} as any)).rejects.toBeInstanceOf(NoReceiptError)
    const [r] = await adapter.list({})
    expect(r.status).toBe('claimed') // untouched — still active
  })

  it('fail records a runtime attempt row in the ledger with the failure reason (key link → attempt-ledger)', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.fail('BL-196', 'missing_access')
    const rows = readAttempts(ledgerDir, 'BL-196')
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('failed')
    expect(rows[0].failureReason).toBe('missing_access')
  })
})

// ═══ the two clocks of a running task: when it was taken, and when it last said it lives ═════
//
// This backend has no renewal call in its library, so it renews a lease by restamping the job's
// own start clock — and that clock used to be the ONLY answer to «when was this work taken».
// Every live task therefore reported a duration of about zero, refreshed every couple of
// minutes, while the work ran for an hour. The contract suite asserts the split on both
// backends; these cases pin the mechanism THIS one uses, which is the payload write.

describe('the claim time and the lease clock are two different writes', () => {
  it('a renewal writes the LEASE only — the claim time in the payload is never touched', async () => {
    const c = mkClock(1000)
    const statements: string[] = []
    const { boss, execSql, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 60000 })
    const adapter = createPgBossQueue({
      boss,
      execSql: async (sql: string, params: any[]) => {
        statements.push(sql)
        return execSql(sql, params)
      },
      clock: c.clock,
      expireMs: 60000,
    })
    await adapter.enqueue(backlog())
    await adapter.claimNext('daemon', {})

    const job = [...jobs.values()][0]
    expect(job.data.claimedAt).toBe(1000) // the claim recorded in the payload, at the claim

    c.advance(30000)
    statements.length = 0
    await adapter.touch('BL-196')

    // The renewal's statements, named: the lease is restamped and the payload is not written.
    expect(statements.some((s) => s.includes('started_on = now()'))).toBe(true)
    expect(statements.some((s) => s.includes('claimedAt'))).toBe(false)
    expect(job.data.claimedAt).toBe(1000) // unmoved by the renewal
    expect(job.started_on).toBe(31000) // the lease clock did move

    const [row] = await adapter.list({})
    expect(row.claimedAt).toBe(1000) // «how long has this been running» is measured from here
    expect(row.leaseRenewedAt).toBe(31000)
  })

  it('a row claimed BEFORE the claim time was recorded falls back to the lease clock, never to nothing', async () => {
    const c = mkClock(1000)
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 60000 })
    await adapter.enqueue(backlog())
    await adapter.claimNext('daemon', {})
    // The pre-existing row: an active job whose payload never carried a claim time, because it
    // was fetched by the version that had only one clock. It states a real time — the one that
    // version recorded — rather than an absence a screen would have to explain.
    const job = [...jobs.values()][0]
    delete job.data.claimedAt
    delete job.data.claimedAtRetry

    const [row] = await adapter.list({})
    expect(row.claimedAt).toBe(job.started_on)
    expect(row.claimedAt).not.toBeNull()
    expect(row.leaseRenewedAt).toBe(job.started_on)
  })
})

// ═══ ГДЕ ЖИВЁТ ЖЕТОН ПОПЫТКИ, И ЧТО С НИМ ДЕЛАЕТ САМА ОЧЕРЕДЬ ═══════════════════════════
//
// Отказ чужому жетону утверждён общим контрактным сьютом — он один на оба бэкенда. Здесь —
// то, чего у памятного бэкенда нет и быть не может: ГРУЗ СТРОКИ и обращение очереди с ним.
//
// Эти дела утверждают ПРОВОД, а не вычисление: что жетон, выданный захватом, — это тот самый
// жетон, который лежит в строке, а не значение, посчитанное рядом с ней. Вычисленный и никуда
// не доехавший жетон — ровно тот класс, которым эта работа уже платила: посчитали, положили в
// журнал и не передали тому, кто им пользуется.
describe('the fencing token lives in the row, and the queue keeps it there', () => {
  it('the token the claim handed out IS the token in the payload, and a new one is stamped only at the next claim', async () => {
    const c = mkClock(1000)
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    await adapter.enqueue(backlog())

    const first = await adapter.claimNext('daemon', {})
    const job = [...jobs.values()][0]
    // ПРОВОД: одно значение, а не два похожих.
    expect(typeof first.attemptToken).toBe('string')
    expect(job.data.attemptToken).toBe(first.attemptToken)

    // Аренда потеряна: очередь перевыдаёт строку СВОИМ планом, и груз она копирует. Строка при
    // этом встаёт во ВТОРОЕ состояние ожидания — так пишет план библиотеки, и подделка теперь
    // тоже: здесь она раньше говорила «created», состояние, в которое библиотека просроченную
    // строку не кладёт никогда.
    c.advance(6000)
    await adapter.list({})
    expect(job.state).toBe('retry')
    // ЖЕТОН УМЕРШЕЙ ПОПЫТКИ ЕЩЁ ЛЕЖИТ В ГРУЗЕ — и это не оплошность, а поведение библиотеки,
    // снятое с живой очереди. Починка, понадеявшаяся на «при перевыдаче стёрлось», разошлась
    // бы с ней молча.
    expect(job.data.attemptToken).toBe(first.attemptToken)

    c.advance(1000)
    const second = await adapter.claimNext('daemon', {})
    // Новая выдача — новый жетон, и захват вернул НОВЫЙ, а не тот, что лежал в грузе до штампа.
    expect(second.attemptToken).not.toBe(first.attemptToken)
    expect(job.data.attemptToken).toBe(second.attemptToken)
  })

  it('the token is written by the SAME statement as the claim time — no second write, no seam of its own', async () => {
    const c = mkClock(1000)
    const statements: string[] = []
    const { boss, execSql } = makeFakeBackend({ clock: c.clock, expireMs: 60000 })
    const adapter = createPgBossQueue({
      boss,
      execSql: async (sql: string, params: any[]) => {
        statements.push(sql)
        return execSql(sql, params)
      },
      clock: c.clock,
      expireMs: 60000,
    })
    await adapter.enqueue(backlog())
    await adapter.claimNext('daemon', {})

    const writes = statements.filter((s) => s.includes('attemptToken'))
    // ОДИН оператор, и это тот же, что пишет время захвата: «новый жетон на каждой выдаче»
    // держится охраной ОДНОГО оператора, а не вторым обещанием, которое можно забыть сдержать.
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('claimedAt')
    expect(writes[0].startsWith('UPDATE pgboss.job')).toBe(true)
  })

  it('a row claimed BEFORE the token existed closes as it always did — an absence is an absence', async () => {
    const c = mkClock(1000)
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 60000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    const claimed = await adapter.claimNext('daemon', {})

    // Строка, захваченная версией, у которой жетона не было вовсе.
    const job = [...jobs.values()][0]
    delete job.data.attemptToken

    // Звонящий предъявляет жетон, а строке предъявить нечего: отказывать ему не за что.
    expect(await adapter.touch('BL-196', { attemptToken: claimed.attemptToken })).toBe(true)
    expect(
      await adapter.complete('BL-196', { receiptRef: 'reverify:old-row', attemptToken: claimed.attemptToken }),
    ).toBe(true)
    const [row] = await adapter.list({})
    expect(row.status).toBe('awaiting_approval')
  })
})

// ═══ ONE SOURCE FOR THE ATTEMPT NUMBER ═══════════════════════════════════════════════
//
// The number used to be computed by two hands out of two different counts: the tick took it
// at the CLAIM and carried it unchanged for the whole attempt, the backend recomputed it from
// the queue's LIVE retry count at the moment of the mutation. Let the queue re-issue the job
// between those two moments and the two hands are talking about different attempts — one
// physical piece of work lands in the ledger as two, and one attempt number ends up carrying
// both `failed` and `completed`. That is not a hypothesis: a real record on the founder's
// machine holds exactly those three rows.
//
// THESE CASES ASSERT THE WIRE, NOT THE ARITHMETIC. What they read is the row ON DISK, written
// through the real `recordAttempt`, and the number a screen would show — because a function
// that computes the right number and a row that carries it are two different guarantees, and
// only the second one is what an audit trail is made of.

describe('an attempt carries ONE number, and the row on disk says so', () => {
  it('один номер: the queue re-counts between the claim and the finish — both rows on disk still carry the number the claim returned', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 60000, ledgerDir })
    await adapter.enqueue(backlog())
    const claimed: any = await adapter.claimNext('daemon', {})
    expect(claimed.attempt).toBe(1)

    // THE TICK'S OWN ROW, written the way loop.mjs writes it: with the number the claim handed
    // it, carried unchanged for the whole attempt — and with the fields only the tick knows.
    recordAttempt(ledgerDir, {
      taskId: 'BL-196',
      attempt: claimed.attempt,
      startedAt: new Date(c.clock()).toISOString(),
      sessionId: '70ed8949-2c26-4065-843f-109bd21f9707',
    })

    // BETWEEN THE CLAIM AND THE FINISH the queue's own retry counter moves: the lease lapsed
    // and the row was handed out again. Nothing about THIS attempt changed — the work that is
    // about to report is the work that was claimed above.
    const job = [...jobs.values()][0]
    job.retry_count = 1

    await adapter.complete('BL-196', { receiptRef: 'r1', workerId: 'local-1', provider: 'claude' })

    const rows = readAttempts(ledgerDir, 'BL-196')
    expect(rows).toHaveLength(2)
    // ONE number across both writers, and it is the one the claim returned.
    expect(rows.map((r: any) => r.attempt)).toEqual([claimed.attempt, claimed.attempt])
    // and the tick's row is still whole — nothing about this fix costs the ledger a field
    expect(rows.some((r: any) => r.sessionId === '70ed8949-2c26-4065-843f-109bd21f9707')).toBe(true)
    expect(rows.some((r: any) => typeof r.startedAt === 'string')).toBe(true)
  })

  it('доска и леджер: the number a screen shows is the number the ledger row carries', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 60000, ledgerDir })
    await adapter.enqueue(backlog())
    const claimed: any = await adapter.claimNext('daemon', {})
    recordAttempt(ledgerDir, { taskId: 'BL-196', attempt: claimed.attempt, startedAt: 'x' })

    const job = [...jobs.values()][0]
    job.retry_count = 1

    const [boardRow] = await adapter.list({})
    await adapter.complete('BL-196', { receiptRef: 'r1', workerId: 'local-1', provider: 'claude' })

    const rows = readAttempts(ledgerDir, 'BL-196')
    // The board and the audit trail say the same thing about the same try. They used to
    // disagree by one, and a person reading the screen would have been reading a third number.
    for (const r of rows) expect(r.attempt).toBe(boardRow.attempt)
    expect(boardRow.attempt).toBe(claimed.attempt)
  })

  it('a job claimed BEFORE the claim count was recorded keeps the OLD arithmetic — an absent mark is an absence, never an invented number', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 60000, ledgerDir })
    await adapter.enqueue(backlog())
    await adapter.claimNext('daemon', {})

    const job = [...jobs.values()][0]
    delete job.data.claimedAt
    delete job.data.claimedAtRetry
    job.retry_count = 1

    const [boardRow] = await adapter.list({})
    await adapter.complete('BL-196', { receiptRef: 'r1', workerId: 'local-1', provider: 'claude' })
    const rows = readAttempts(ledgerDir, 'BL-196')

    // exactly what this row recorded before the claim mark existed: 1 + the live retry count
    expect(boardRow.attempt).toBe(2)
    expect(rows[0].attempt).toBe(2)
  })
})

// ═══ the attempt stamp on the ADAPTER's own rows (2026-08-05) ═══════
//
// Until this landed the backend's two `recordAttempt` call sites passed none of the seven
// stamp fields and no status change was ever routed through `applyTransition`. These cases
// pin what the adapter can now truthfully say — and, just as deliberately, what it cannot.

describe('the queue adapter stamps the attempt row it writes', () => {
  it('complete() routes RUNNING -> PRODUCED through the machine and stamps key, version, attempt and envelope digest', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.complete('BL-196', { receiptRef: 'reverify:green', workerId: 'w1' })

    const [row] = readAttempts(ledgerDir, 'BL-196')
    expect(row.attempt).toBe(1) // the number the QUEUE holds, not one the caller supplied
    expect(row.stateMachineVersion).toBe(STATE_MACHINE_VERSION)
    expect(row.idempotencyKey).toBe(idempotencyKey('BL-196', 'BL-196#1', 'RUNNING->PRODUCED'))
    // The envelope reaches the durable row as a DIGEST and never as paths.
    expect(row.capabilityEnvelopeHash).toBe(envelopeHash(defaultEnvelope('prod')))
    expect(row.capabilityEnvelope).toBeUndefined()
  })

  it('fail() routes RUNNING -> RETRYABLE, and the key is the one of the attempt the QUEUE names', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    // A task already on its second attempt: the number rides in the job payload, and the
    // adapter reads it from there rather than defaulting to 1 about itself.
    await adapter.enqueue(backlog({ id: 'BL-A2', attempt: 2 }))
    await adapter.claimNext('w1', {})
    await adapter.fail('BL-A2', 'tests_red')

    const [row] = readAttempts(ledgerDir, 'BL-A2')
    expect(row.attempt).toBe(2)
    expect(row.idempotencyKey).toBe(idempotencyKey('BL-A2', 'BL-A2#2', 'RUNNING->RETRYABLE'))
    // A different attempt of the SAME task is a different key by construction — that is the
    // half of fleet invariant 5 the queue layer has to keep from its side.
    expect(row.idempotencyKey).not.toBe(idempotencyKey('BL-A2', 'BL-A2#1', 'RUNNING->RETRYABLE'))
  })

  it('leaves the four fields it cannot observe ABSENT rather than inventing them', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.complete('BL-196', { receiptRef: 'reverify:green' })

    const [row] = readAttempts(ledgerDir, 'BL-196')
    // policyVersion: the daemon's routing policy carries no version.
    // memorySnapshotHash: the backend does not know which corpus the worker read (the tick does).
    // harnessVersion: nothing in this process observes the agent CLI's version.
    // planHash: a task has a title and an acceptance sentence, not a plan document.
    for (const absent of ['policyVersion', 'memorySnapshotHash', 'harnessVersion', 'planHash']) {
      expect(Object.hasOwn(row, absent)).toBe(false)
    }
  })

  it('a seam that does not surface the job payload writes NO stamp instead of a guessed one', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    // The pre-2026-08-05 fake: the active-job resolution answers with id and name only.
    const { adapter: full, boss } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })
    const narrow = createPgBossQueue({
      boss,
      execSql: async (sql: string, params: any[]) => {
        const res: any = await (full as any).execSql(sql, params)
        if (!sql.includes("state = 'active'")) return res
        return { rows: res.rows.map((r: any) => ({ id: r.id, name: r.name })) }
      },
      clock: c.clock,
      expireMs: 5000,
      ledgerDir,
    })
    await narrow.enqueue(backlog({ id: 'BL-NARROW' }))
    await narrow.claimNext('w1', {})
    await narrow.fail('BL-NARROW', 'agent_error')

    const [row] = readAttempts(ledgerDir, 'BL-NARROW')
    expect(row.failureReason).toBe('agent_error') // the row is still written, in full
    for (const absent of ['attempt', 'idempotencyKey', 'stateMachineVersion', 'capabilityEnvelopeHash']) {
      expect(Object.hasOwn(row, absent)).toBe(false)
    }
  })
})

// ═══ the approval row is read back, and only where it may speak ═══════════════════════
//
// Writing the row was half a sentence: while list() read the job table alone, work that had
// finished and was waiting for a person looked exactly like work a person had accepted, so
// the screen showing what waits had nothing to draw and its counter read zero. These cases
// pin the join, the one place the side table is allowed to overrule pg-boss, and the
// fail-open that keeps a restricted database from costing the rows themselves.

describe('the approval row reaches the read path', () => {
  it('completed work is reported as awaiting approval, and stats() moves it out of completed', async () => {
    const c = mkClock()
    const { adapter, attempts } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.complete('BL-196', { receiptRef: 'reverify:green' })

    // the durable half: complete() wrote the row through the very seam list() reads
    expect(attempts.get('BL-196').status).toBe('awaiting_approval')

    const [row] = await adapter.list({})
    expect(row.status).toBe('awaiting_approval')
    expect(await adapter.list({ status: 'awaiting_approval' })).toHaveLength(1)

    const s = await adapter.stats()
    expect(s.awaiting_approval).toBe(1)
    // ONE population, read twice — counting it in both places would make stats() disagree
    // with list(), where a row holds exactly one status.
    expect(s.completed).toBe(0)
    expect(s.total).toBe(1)
  })

  it('a decided task does NOT leave the closed vocabulary: approved reads as completed, not as "approved"', async () => {
    const c = mkClock()
    const { adapter, attempts } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    await adapter.complete('BL-196', { receiptRef: 'reverify:green' })
    // the front's approve path CASed the row to its decided value
    attempts.set('BL-196', { status: 'approved', merge_receipt: 'merge:abc' })

    const [row] = await adapter.list({})
    expect(row.status).toBe('completed') // the night's finished work still has a place to appear
    expect(row.mergeReceipt).toBe('merge:abc')
    expect((await adapter.stats()).awaiting_approval).toBe(0)
  })

  it('the side table may speak ONLY about finished work: a live claim is never overruled', async () => {
    const c = mkClock()
    const { adapter, attempts } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    await adapter.claimNext('w1', {})
    // a stale row from a PREVIOUS decision on the same task, while the job is active again
    attempts.set('BL-196', { status: 'approved' })
    expect((await adapter.list({}))[0].status).toBe('claimed')

    attempts.set('BL-196', { status: 'awaiting_approval' })
    expect((await adapter.list({}))[0].status).toBe('claimed') // still running — nobody is waiting yet
  })

  it('FAIL-OPEN: a database that refuses the approval join still answers about the WORK', async () => {
    const c = mkClock()
    const logged: string[] = []
    const { boss, execSql } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    // the restricted database: every statement naming the approval table is refused —
    // the join, the counter and the write alike (no CREATE right, the approval-store case)
    const restricted = createPgBossQueue({
      boss,
      execSql: async (sql: string, params: any[]) => {
        if (sql.includes('sma_task_attempts')) throw new Error('permission denied for relation sma_task_attempts')
        return execSql(sql, params)
      },
      clock: c.clock,
      expireMs: 5000,
      log: (m: string) => logged.push(m),
    })
    await restricted.enqueue(backlog({ id: 'BL-OPEN' }))
    await restricted.claimNext('w1', {})
    await restricted.complete('BL-OPEN', { receiptRef: 'reverify:green' })

    const rows = await restricted.list({}) // does not throw
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('completed') // the job's own state, the pre-join reading
    const s = await restricted.stats()
    // FAIL-OPEN MEANS «DOES NOT THROW AND DOES NOT COST THE WORK ITS COUNTS» — never «invents
    // a number». A table that refused to answer is «нет данных», and a screen says so; a zero
    // here would read as «никто не ждёт решения» over a growing pile, which is the exact
    // reading this join was added to end.
    expect(s.awaiting_approval).toBeNull()
    expect(s.queued).toBe(0) // and the WORK still answers: these come from the library
    expect(s.total).toBe(1)
    expect(logged.some((m) => m.includes('approval join unavailable'))).toBe(true)
    // one broken permission polled every few seconds is still ONE log line
    expect(logged.filter((m) => m.includes('approval join unavailable'))).toHaveLength(1)
  })
})

// ═══ THE COUNTERS NAME THEIR SOURCE ═══════════════════════════════════════════════════════
//
// `stats()` asked pg-boss for `queued/created/active/claimed/completed/failed` — our words,
// spoken at a library that answers `queuedCount/activeCount/totalCount/deferredCount` and
// counts no finished or broken work at all. Six reads of `undefined ?? 0`, and the board
// printed the zeros: «сделано за смену: 0» is a plausible day, so nobody went looking. These
// cases pin the three halves of the cure — the names are the library's, the two counts it does
// not keep come from the journal that does, and a source that did not answer says «нет данных»
// instead of zero.

describe('stats() takes every number from a source that exists', () => {
  /** The keys pg-boss can actually put on a getQueueStats answer — read off the library. */
  const realKeys = everyKeyTheAnswerMayCarry()

  it('the fake in this suite is not BIGGER than the library it stands for', async () => {
    const c = mkClock()
    const { adapter, boss } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    await adapter.enqueue(backlog())
    const answer = await boss.getQueueStats('sma.task.prod')

    const invented = Object.keys(answer).filter((k) => !realKeys.includes(k))
    expect(invented, `the fake answers ${invented.join(', ')}, which pg-boss never does`).toEqual([])
    // Named on purpose: these two are what the fake used to invent, and inventing them is what
    // let the suite agree with a backend asking the live queue a question it cannot hear.
    expect(Object.keys(answer)).not.toContain('completed')
    expect(Object.keys(answer)).not.toContain('failed')
  })

  it('stats() reads ONLY names the real pg-boss answers to', async () => {
    const c = mkClock()
    const { boss, execSql } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    const read = new Set<string>()
    // Every property the backend touches on the answer is recorded. A recorder rather than a
    // source-code regex: what matters is the name that was ASKED FOR at runtime, and a regex
    // over the source is a second reading that can agree with the wrong thing.
    const watched = {
      ...boss,
      async getQueueStats(name: string) {
        const answer = await boss.getQueueStats(name)
        return new Proxy(answer, {
          get(t: any, p: string | symbol) {
            // `then` is read by `await` itself, not by the backend.
            if (typeof p === 'string' && p !== 'then') read.add(p)
            return t[p as any]
          },
        })
      },
    }
    const adapter = createPgBossQueue({
      boss: watched,
      execSql,
      clock: c.clock,
      expireMs: 5000,
      ledgerDir: mkLedgerDir(),
    })
    await adapter.enqueue(backlog())
    await adapter.stats()

    // Vacancy check — a stats() that read nothing would pass an emptiness test.
    expect(read.size).toBeGreaterThan(2)
    const unknown = [...read].filter((k) => !realKeys.includes(k))
    expect(unknown, `stats() asked pg-boss for ${unknown.join(', ')} — no such key in its answer`).toEqual([])
  })

  it('завершённое и провальное берутся из журнала попыток и совпадают с ним', async () => {
    const c = mkClock()
    const ledgerDir = mkLedgerDir()
    const { adapter, attempts } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir })

    await adapter.enqueue(backlog({ id: 'BL-DONE' }))
    await adapter.claimNext('w1', {})
    await adapter.complete('BL-DONE', { receiptRef: 'reverify:green' })

    await adapter.enqueue(backlog({ id: 'BL-BROKE' }))
    await adapter.claimNext('w2', {})
    await adapter.fail('BL-BROKE', 'missing_access')

    // What the journal itself says, read through its own counter.
    expect(countTerminalOutcomes(ledgerDir)).toEqual({ completed: 1, failed: 1 })
    // …and what a reader sees, once the finished one is moved into «ждут решения» rather than
    // counted twice (the population rule stats() has always kept with list()).
    const waiting = await adapter.stats()
    expect(waiting.awaiting_approval).toBe(1)
    expect(waiting.completed).toBe(0)
    expect(waiting.failed).toBe(1)

    // The person says yes, and the number the journal has been holding all along appears.
    attempts.set('BL-DONE', { status: 'approved', merge_receipt: 'merge:abc' })
    const decided = await adapter.stats()
    expect(decided.awaiting_approval).toBe(0)
    expect(decided.completed).toBe(1)
    expect(decided.completed).toBe(countTerminalOutcomes(ledgerDir).completed)
    expect(decided.failed).toBe(countTerminalOutcomes(ledgerDir).failed)
  })

  it('без журнала это «нет данных», а не ноль — и работа при этом всё равно считается', async () => {
    const c = mkClock()
    const { boss, execSql } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    // No ledgerDir: there is NOTHING that knows how work ended. Zero here would read as
    // «сегодня ничего не сделали», which is the sentence this whole task is about.
    const noLedger = createPgBossQueue({ boss, execSql, clock: c.clock, expireMs: 5000 })
    await noLedger.enqueue(backlog())
    await noLedger.claimNext('w1', {})

    const s = await noLedger.stats()
    expect(s.completed).toBeNull()
    expect(s.failed).toBeNull()
    expect(s.completed).not.toBe(0)
    expect(s.claimed).toBe(1) // the library's own counts are unaffected
    expect(s.total).toBe(1)
  })

  it('a lane that answers without the key makes the WHOLE column «нет данных», never a partial sum', async () => {
    const c = mkClock()
    const { boss, execSql } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    // One lane's answer loses the count — the shape a renamed column would arrive in. A sum
    // over the other three lanes presented as the total would be the same class of lie, only
    // quieter: a number that is wrong by an unknown amount.
    const partial = {
      ...boss,
      async getQueueStats(name: string) {
        const answer: any = await boss.getQueueStats(name)
        if (name === 'sma.task.research') delete answer.queuedCount
        return answer
      },
    }
    const adapter = createPgBossQueue({
      boss: partial,
      execSql,
      clock: c.clock,
      expireMs: 5000,
      ledgerDir: mkLedgerDir(),
    })
    await adapter.enqueue(backlog())

    const s = await adapter.stats()
    expect(s.queued).toBeNull()
    expect(s.claimed).toBe(0) // the columns that DID answer still answer
    expect(s.total).toBe(1)
  })
})

describe('pg-boss backend — start() lane provisioning', () => {
  it('start() creates the dead-letter queue FIRST, then the four lane queues and the batch queue with the shared deadLetter', async () => {
    const c = mkClock()
    const { adapter, createQueueCalls } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    await adapter.start()
    // pg-boss v11 rejects a lane queue whose deadLetter target does not exist yet
    // (the pilot fresh-boot finding) — the shared dead queue must be provisioned first.
    // The batch queue is provisioned like the lanes and fetched like none of them: that is
    // what keeps the request of a batch structurally out of a worker's hands.
    expect(createQueueCalls.map((x) => x.name)).toEqual([
      'sma.task.dead',
      'sma.task.prod',
      'sma.task.research',
      'sma.task.paperwork',
      'sma.task.forge',
      'sma.batch',
    ])
    expect(createQueueCalls[0].opts?.deadLetter).toBeUndefined()
    for (const call of createQueueCalls.slice(1)) expect(call.opts.deadLetter).toBe(DEAD_LETTER_QUEUE)
    // exported vocabulary matches
    expect([...TASK_QUEUE_LANES]).toEqual(['prod', 'research', 'paperwork', 'forge'])
    expect(BATCH_PARENT_QUEUE).toBe('sma.batch')
    expect(TASK_QUEUE_LANES.map((l) => `sma.task.${l}`)).not.toContain(BATCH_PARENT_QUEUE)
  })
})

/**
 * THE DURABLE HALF OF «THE REQUEST IS NEVER HANDED OUT».
 *
 * The contract suite asserts the PROMISE against every backend; these two cases assert the
 * MECHANISM this backend keeps it with, because the mechanism is a layout decision a later
 * edit could undo without any promise visibly breaking first: the parent is SENT somewhere
 * `fetch` never looks, and claimNext fetches lane queues only.
 */
describe('pg-boss backend — a batch request is not sent where a fetch can reach it', () => {
  const parent = (batchId: string) => ({
    id: batchId,
    source: 'roster',
    title: 'разгреби мелочь перед демо',
    lane: 'prod',
    batchId,
    data: { batch: 'parent' },
  })

  it('the request goes to the batch queue and the items to their lanes — and no fetch ever names the batch queue', async () => {
    const c = mkClock()
    const { adapter, sendCalls, boss } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    const fetched: string[] = []
    const realFetch = boss.fetch.bind(boss)
    boss.fetch = async (name: string, options: any) => {
      fetched.push(name)
      return realFetch(name, options)
    }

    await adapter.enqueue(parent('B-77'))
    await adapter.enqueue({ id: 'B-77-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-77' })

    expect(sendCalls.map((x) => x.name)).toEqual(['sma.batch', 'sma.task.prod'])

    const claimed = await adapter.claimNext('w1', {})
    expect(claimed.id).toBe('B-77-1')
    expect(await adapter.claimNext('w2', {})).toBeNull()
    expect(fetched).not.toContain('sma.batch')
  })

  it('the request is READ back with the work — a list that hides it leaves a screen with loose items', async () => {
    const c = mkClock()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000 })
    await adapter.enqueue(parent('B-78'))
    await adapter.enqueue({ id: 'B-78-1', source: 'roster', title: 'первый', lane: 'prod', batchId: 'B-78' })

    const rows = await adapter.list({})
    const row = rows.find((r: any) => r.id === 'B-78')
    expect(row).toBeTruthy()
    expect(row.batchId).toBe('B-78')
    expect(row.data.batch).toBe('parent')
    expect(rows.find((r: any) => r.id === 'B-78-1').batchId).toBe('B-78')
  })
})

/**
 * КЕМ РАБОТУ ПРОСИЛИ ВЕСТИ — И ПОЧЕМУ ЭТО СПРАШИВАЕТСЯ У ЭТОГО БЭКЕНДА ОТДЕЛЬНО.
 *
 * Дверь возврата пересобирает повторную постановку РОВНО из строк `list()` и ничего другого о
 * задаче не знает. Пока роль на строке не ехала, работа, названная поимённо, ставилась заново
 * БЕЗ имени: не отказ, а забывчивость — и названного специалиста молча вёл ИСПОЛНИТЕЛЬ, ровно
 * та подмена, ради запрета которой роль и завели. У куска сборки та же потеря стоит дороже:
 * повтор без роли просит исполнителя, `poolFor` называет это `role_mismatch`, и сборка,
 * закреплённая за специалистом, меняет работника — правило «одна сборка — один работник»
 * расклеивается на первом же повторе.
 *
 * ПОЛЕ ПОЧИНИЛИ В ДВУХ БЭКЕНДАХ ЗЕРКАЛЬНО, А ЗАМЕРИЛИ В ОДНОМ — в памяти
 * (`role-survives-return.test.ts` держит эталонную половину целиком, через двери). В бою очередь
 * ЭТА, и её половина держалась на честном слове коммита: потеряй она роль здесь — вышла бы та же
 * тихая подмена, а весь прогон остался бы зелёным, потому что каждый случай про роль поднимает
 * очередь в памяти. Здесь эта половина имеет зубы.
 *
 * ПОЧЕМУ НЕ В ОБЩЕМ КОНТРАКТЕ, где ему место и где его прошли бы оба бэкенда разом: `adapter.mjs`
 * в момент этой правки держала другая сессия того же рабочего дерева, и запись в него была бы
 * гонкой, а не помощью. Случай написан так, чтобы переехать в контракт без изменений.
 */
describe('pg-boss backend — строка списка помнит, кем работу просили вести', () => {
  it('роль, которой назвали работу, видна на строке — и в том состоянии, где её читает возврат', async () => {
    const c = mkClock()
    const { adapter } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })

    await adapter.enqueue({
      id: 'R-named',
      source: 'roster',
      title: 'к исследователю',
      lane: 'prod',
      role: 'ai-researcher',
    })
    await adapter.enqueue({ id: 'R-plain', source: 'roster', title: 'обычная работа', lane: 'prod' })

    const rows = await adapter.list({})
    expect(rows.find((r: any) => r.id === 'R-named').role).toBe('ai-researcher')
    // Работа, никем поимённо не названная, о роли не говорит НИЧЕГО — не «null», который каждому
    // читателю пришлось бы отличать от имени. «Не назвали» и «назвали исполнителя» — разные
    // факты (см. roleIsNamed), и бэкенд, кладущий сюда null, стёр бы различие молча.
    expect(rows.find((r: any) => r.id === 'R-plain').role).toBeUndefined()

    // И В ТОМ СОСТОЯНИИ, В КОТОРОМ ЭТУ СТРОКУ ЧИТАЕТ ДВЕРЬ ВОЗВРАТА: работа уже сделана и ждёт
    // человека. Роль, дожившая до очереди, но пропавшая к этому моменту, — та же подмена, только
    // позже: возврат прочитал бы строку без имени и поставил бы работу заново без него.
    const claimed = await adapter.claimNext('w1', {})
    expect(claimed.id).toBe('R-named')
    await adapter.complete(claimed.id, { receiptRef: 'reverify:ok', attemptToken: claimed.attemptToken })

    const back = (await adapter.list({})).find((r: any) => r.id === 'R-named')
    expect(back.status).toBe('awaiting_approval')
    expect(back.role).toBe('ai-researcher')
  })
})

// ── attempt-ledger direct invariants (Task 2) ──
describe('attempt-ledger — append-only per-task history', () => {
  it('recordAttempt appends and readAttempts returns rows ordered by attempt number', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-9', attempt: 2, outcome: 'failed', failureReason: 'agent_error' })
    recordAttempt(dir, { taskId: 'BL-9', attempt: 1, outcome: 'failed', failureReason: 'timeout' })
    recordAttempt(dir, { taskId: 'BL-9', attempt: 3, outcome: 'completed', receiptRef: 'reverify:ok' })
    const rows = readAttempts(dir, 'BL-9')
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3])
    expect(rows[2].receiptRef).toBe('reverify:ok')
    expect(rows[0].failureReason).toBe('timeout')
  })

  it('readAttempts on a missing ledger is fail-open ([])', () => {
    const dir = mkLedgerDir()
    expect(readAttempts(dir, 'BL-none')).toEqual([])
  })

  it('recordAttempt drops keys outside the allowlist (explicit-pick)', () => {
    const dir = mkLedgerDir()
    recordAttempt(dir, { taskId: 'BL-x', outcome: 'completed', secret: 'nope' } as any)
    const [row] = readAttempts(dir, 'BL-x')
    expect(row.outcome).toBe('completed')
    expect((row as any).secret).toBeUndefined()
  })
})

// ── the two ends of a failed attempt, at the door where the repeat is actually decided ──

/**
 * ГДЕ ЖИВЁТ ПОВТОР — И ПОЧЕМУ ЕГО ВИДНО ТОЛЬКО ПО ДВЕРИ.
 *
 * Отказ в этой очереди — ВОЗВРАЩАЕМЫЙ исход, и ветку «вернуть в очередь или закрыть» выбирает
 * САМА БИБЛИОТЕКА внутри `boss.fail`, по `retryLimit` (об этом сказано в шапке бэкенда). Снаружи
 * этот выбор не наблюдается ничем, кроме того, кого позвали: позвали отказ — значит два повтора
 * с тем же потолком на командной строке решены и оплачены заранее.
 *
 * Поэтому дела ниже утверждают ДВЕРЬ, а не состояние: упор в потолок ходов не имеет права
 * доехать до `boss.fail`, а всякая прочая причина обязана доезжать туда ровно как раньше — с
 * нетронутым планом перевыдач у строки. Половина того же провода со стороны цикла — в
 * `turn-cap-parks-wire.test.ts`.
 */
describe('pg-boss backend — упор в потолок ходов паркуется, прочие причины повторяются', () => {
  it('turns_exhausted НЕ идёт в boss.fail: строку забирают из очереди, а не отдают на повтор', async () => {
    const c = mkClock()
    const { adapter, boss, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    const failCalls: any[] = []
    const cancelCalls: any[] = []
    const realFail = boss.fail.bind(boss)
    const realCancel = boss.cancel.bind(boss)
    boss.fail = async (name: string, id: string, out: any) => {
      failCalls.push({ name, id, out })
      return realFail(name, id, out)
    }
    boss.cancel = async (name: string, id: string) => {
      cancelCalls.push({ name, id })
      return realCancel(name, id)
    }

    await adapter.enqueue(backlog({ id: 'BL-CAP' }))
    const taken = await adapter.claimNext('w1', {})
    expect(taken.id).toBe('BL-CAP')

    expect(await adapter.parkForPerson('BL-CAP', 'turns_exhausted', { attemptToken: taken.attemptToken })).toBe(true)

    // ДВЕРЬ ПОВТОРА НЕ ТРОНУТА — именно в ней библиотека и решает про перевыдачу.
    expect(failCalls).toHaveLength(0)
    expect(cancelCalls).toHaveLength(1)

    // И строка больше не достижима ни для одной выдачи — ни сейчас, ни после задержки повтора.
    const handed = []
    for (let i = 0; i < 3; i += 1) {
      handed.push(await adapter.claimNext('w2', {}))
      c.advance(60000)
    }
    expect(handed).toEqual([null, null, null])

    const row = (await adapter.list({})).find((r: any) => r.id === 'BL-CAP')
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('turns_exhausted')
    // Строка ушла из состояний, из которых библиотека раздаёт работу.
    const job = [...jobs.values()].find((j: any) => j.data && j.data.id === 'BL-CAP')
    expect(['created', 'retry', 'active']).not.toContain(job.state)
  })

  it('прочие причины идут в boss.fail как раньше — план перевыдач строки не тронут', async () => {
    const c = mkClock()
    const { adapter, boss, jobs } = makeFakeBackend({ clock: c.clock, expireMs: 5000, ledgerDir: mkLedgerDir() })
    const failCalls: any[] = []
    const cancelCalls: any[] = []
    const realFail = boss.fail.bind(boss)
    const realCancel = boss.cancel.bind(boss)
    boss.fail = async (name: string, id: string, out: any) => {
      failCalls.push({ name, id, out })
      return realFail(name, id, out)
    }
    boss.cancel = async (name: string, id: string) => {
      cancelCalls.push({ name, id })
      return realCancel(name, id)
    }

    await adapter.enqueue(backlog({ id: 'BL-RED' }))
    const taken = await adapter.claimNext('w1', {})
    await adapter.fail('BL-RED', 'tests_red', { attemptToken: taken.attemptToken })

    expect(cancelCalls).toHaveLength(0)
    expect(failCalls).toHaveLength(1)
    expect(failCalls[0].out).toEqual({ reason: 'tests_red' })

    // Граница перевыдач на строке — та же, что была: развилка не отняла повтор ни у кого,
    // кроме одной названной причины.
    const job = [...jobs.values()].find((j: any) => j.data && j.data.id === 'BL-RED')
    expect(job.retryLimit).toBe(2)
  })
})
