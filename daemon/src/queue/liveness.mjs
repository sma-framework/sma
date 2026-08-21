/**
 * liveness.mjs — the durable liveness sweep.
 *
 * THE CONTRACT (Paperclip §8 as ТЗ / SPECIFICATION, our own implementation — no code
 * copied; see THIRD-PARTY-LICENSES.md): «every NON-TERMINAL task MUST have a durable
 * live path — a queued job, an active job with a FRESH touch, or a scheduled retry. A
 * background PID is NOT a live path.» One daemon tick audits this over DURABLE state
 * ONLY (the QueueAdapter + the attempt ledger) and requeues any violation.
 *
 * STATELESS BY LAW: there is NO in-memory registry of live
 * tasks, NO Map of running PIDs here — any such structure would be a bug. The sweep
 * reads `adapter.list()` (Postgres truth) every tick; the daemon is killable at any
 * line, and on restart the sweep re-derives every task's live path from durable state.
 *
 * REQUEUE MECHANICS: a stale-active task is requeued by `adapter.fail(id,
 * 'runtime_offline')`. On the pg-boss backend this hands the SAME job row back to
 * pg-boss's retryLimit/retryBackoff — «замолчал — задача вернулась в очередь» falls
 * out of the library, WITHOUT re-enqueuing (so no task field is lost). The adapter's
 * fail() is also what appends the durable attempt row. The sweep is the
 * belt-and-suspenders AUDIT on top of pg-boss's own expiry.
 *
 * REWAKE THROTTLE: a task with >= 2 consecutive no-progress
 * attempts is subject to computeCooldownMs(n) = min(120000 * 2^(n-2), 1800000) before
 * it should be woken again — coalescing + exponential backoff so a wedged task can
 * never burn a night window in a wake storm. The formula is exported and unit-tested;
 * the real delay is realized by pg-boss retryBackoff at requeue time.
 *
 * IT KILLS NOW, AND IT STILL KEEPS NO STATE. Declaring an attempt dead used to be the whole
 * job: the row went back to the queue and the CHILD KEPT RUNNING. A closed row with a live
 * process behind it is the worst shape this machine can take — the next tick starts another
 * attempt at the same task, and two children burn one subscription each believing it is alone.
 * So the sweep stops the child FIRST and reissues the task after. It does that WITHOUT a
 * registry of its own: the kill-handle registry arrives as a COLLABORATOR, exactly the way the
 * journal does, and is never imported, constructed or cached here. The law above is untouched —
 * nothing remembered between ticks, and a daemon assembled without the collaborator sweeps
 * exactly as it always did.
 *
 * THE HONEST BOUNDARY. A handle exists only inside the daemon that spawned the attempt. After a
 * restart there is nothing to kill, and that is NOT a killing — it is a different outcome with a
 * different line in the log, so a reader is never told a process died when it was merely orphaned.
 *
 * Node built-ins only; `clock` is dependency-injected so the sweep is deterministic in
 * tests. No live Postgres — the adapter + ledger are injected fakes in the suite.
 */

import { DEFAULT_EXPIRE_MS } from './adapter.mjs'

const BASE_COOLDOWN_MS = 120000 // 120s
const MAX_COOLDOWN_MS = 1800000 // 30 min

/**
 * computeCooldownMs(noProgressRuns) — the exponential rewake throttle. 0 for the first
 * run (n<2); from n=2, min(120000 * 2^(n-2), 1800000).
 *
 * @param {number} noProgressRuns  1-based count of consecutive no-progress attempts
 * @returns {number} cooldown in ms
 */
export function computeCooldownMs(noProgressRuns) {
  const n = Number(noProgressRuns) || 0
  if (n < 2) return 0
  const raw = BASE_COOLDOWN_MS * 2 ** (n - 2)
  return Math.min(raw, MAX_COOLDOWN_MS)
}

/** Consecutive no-progress (failed) attempts already on record for a task. */
function countNoProgress(attempts) {
  if (!Array.isArray(attempts)) return 0
  let n = 0
  for (const a of attempts) if (a && a.outcome === 'failed') n += 1
  return n
}

/**
 * livenessSweep({adapter, ledger, clock, expireMs, journal, attemptTurns}) — audit every non-terminal task
 * for a durable live path; requeue the ones that lost it. Returns a summary.
 *
 * A task is:
 *   - terminal (completed/failed) → not audited (no live-path obligation);
 *   - queued → OK (queued IS a durable live path);
 *   - active with a fresh renewal (now - leaseRenewedAt <= expireMs) → OK;
 *   - active with a STALE touch → no live path → adapter.fail(id, 'runtime_offline')
 *     (→ attempt row via the adapter + pg-boss auto-retry), counted as requeued, and
 *     counted as throttled when its cooldown (>= 2 no-progress runs) is non-zero.
 *
 * IT SAYS SO OUT LOUD. This sweep declares an attempt dead and hands its task back to the
 * queue, and until now it did that WITHOUT WRITING A WORD. On the day it fired and reissued a
 * task, the operator log held nothing about it but the consequences — the whole day's log
 * answers `grep -c liveness` with zero — and the investigation of that day had to be run on
 * circumstantial evidence. One line ends a whole class of «why did this restart»: which task,
 * which attempt, how long it had been silent, the deadline it missed, how many fruitless runs
 * are on its record and the cooldown that follows.
 *
 * THE LINE COMES FIRST, before the failure is declared: written afterwards, a throw from the
 * declaration would leave the log exactly as empty as it was before — the one case where the
 * line is worth most.
 *
 * AND THE JOURNAL IS NEVER A CONDITION OF THE SWEEP. No seam, a seam that throws — the sweep
 * does its work unchanged and silently. Narration is an observation of the audit, never a part
 * of it: a task must not survive or die on whether a log could be written.
 *
 * THE ORDER IS THE POINT: stop the child, SAY what came of stopping it, then reissue the task.
 * Reversed, it is the exact loop that once ran three processes against one row — the row is
 * closed while the child lives on, so the next tick sees a task with no live path and starts
 * yet another attempt.
 *
 * @param {{adapter:object, ledger?:object, clock?:Function|number, expireMs?:number, journal?:Function, attemptTurns?:object}} opts
 * @returns {Promise<{audited:number, requeued:number, throttled:number}>}
 */
export async function livenessSweep({ adapter, ledger, clock = Date.now, expireMs = DEFAULT_EXPIRE_MS, journal, attemptTurns } = {}) {
  if (!adapter || typeof adapter.list !== 'function' || typeof adapter.fail !== 'function') {
    throw new TypeError('livenessSweep requires an adapter with list() and fail()')
  }
  const now = () => (typeof clock === 'function' ? clock() : clock)
  const rows = await adapter.list({}) // durable read — never an in-memory registry
  let audited = 0
  let requeued = 0
  let throttled = 0

  for (const r of rows) {
    if (r.status === 'completed' || r.status === 'failed') continue
    audited += 1
    if (r.status !== 'claimed') continue // queued / retry = durable live path (OK)

    // THE RENEWAL CLOCK, NOT THE CLAIM CLOCK. A row states both: when the attempt was taken and
    // when its lease was last renewed. This sweep asks «has this worker gone silent», which only
    // the renewal answers — measuring from the claim would declare every attempt that outlives
    // one lease period dead WHILE IT RUNS, kill nothing, and hand the same task to a second
    // worker and a third. That is the exact fault this file exists to catch, so it may not be
    // the one this file causes. `claimedAt` remains the fallback for a backend that renews by
    // restamping the same clock it claimed on — there the two are one value and either reads
    // correctly.
    const lastTouch = r.leaseRenewedAt ?? r.claimedAt ?? 0
    if (now() - lastTouch <= expireMs) continue // active + fresh renewal (OK)

    // Stale active: the worker went silent — no durable live path. Requeue it.
    const prior = ledger && typeof ledger.readAttempts === 'function' ? ledger.readAttempts(r.id) : []
    const noProgress = countNoProgress(prior) + 1 // this failure
    const silentMs = now() - lastTouch
    const cooldownMs = computeCooldownMs(noProgress)
    // THE ONE LINE (see the header) — written BEFORE the declaration and fail-open. It states the
    // DECISION only: what became of the process is a different fact, it gets its own line below,
    // and at this point the answer is not known yet.
    if (typeof journal === 'function') {
      try {
        journal({
          type: 'liveness.attempt_dead',
          taskId: r.id,
          attempt: r.attempt ?? null,
          silentMs,
          expireMs,
          noProgressRuns: noProgress,
          cooldownMs,
          detail:
            `попытка ${r.attempt ?? '?'} задачи ${r.id} объявлена мёртвой: молчит ${Math.round(silentMs / 1000)} с ` +
            `при сроке ${Math.round(expireMs / 1000)} с; задача перевыдана в очередь` +
            (cooldownMs > 0 ? `, остывание ${Math.round(cooldownMs / 1000)} с` : '') +
            '. Что стало с процессом — отдельной строкой ниже.',
        })
      } catch {
        /* повествование никогда не стоит задачи */
      }
    }
    // ── (а) УБИТЬ. Чужой ручкой: реестр приходит коллаборатором, как и журнал, и своего
    // состояния сторож не заводит — иначе перезапуск демона перестанет быть бесплатным, а весь
    // этот файл написан ровно ради того, чтобы демон был убиваем на любой строке. Ручка
    // адресуется идентификатором ЗАДАЧИ: второго способа дотянуться до процесса здесь нет, и
    // заводить его значило бы открыть путь к убийству не того ребёнка.
    // `null` — это «не спрашивали или ответ неизвестен», и это НЕ ветка исхода.
    let killed = null
    if (attemptTurns && typeof attemptTurns.stop === 'function') {
      try {
        killed = attemptTurns.stop(r.id) === true
      } catch {
        // Реестр сломался — что стало с ребёнком, неизвестно. Ни одной строки об исходе: и
        // «убили», и «убивать было нечем» здесь были бы выдумкой, каждая в свою сторону.
        killed = null
      }
    }
    // ── (б) СКАЗАТЬ. Две РАЗНЫЕ строки, различимые поиском по журналу. Перевыдача работала и
    // раньше, поэтому строка про осиротевший процесс ничего нового не доказывает — и не смеет
    // выглядеть так, будто доказывает убийство.
    if (killed !== null && typeof journal === 'function') {
      try {
        journal(
          killed
            ? {
                type: 'liveness.attempt_killed',
                taskId: r.id,
                attempt: r.attempt ?? null,
                killed: true,
                detail:
                  `попытка ${r.attempt ?? '?'} задачи ${r.id}: ручка была у этого демона — ` +
                  'дочерний процесс остановлен ДО того, как задача перевыдана в очередь.',
              }
            : {
                type: 'liveness.attempt_orphaned',
                taskId: r.id,
                attempt: r.attempt ?? null,
                killed: false,
                detail:
                  `попытка ${r.attempt ?? '?'} задачи ${r.id}: ручки под рукой нет — процесс ` +
                  'осиротел (его породил другой демон, либо демон был перезапущен). Останавливать ' +
                  'нечем; задача перевыдана в очередь.',
              },
        )
      } catch {
        /* повествование никогда не стоит задачи */
      }
    }
    // ── (в) ПЕРЕВЫДАТЬ. Только теперь: обратный порядок закрывает строку при живом ребёнке.
    await adapter.fail(r.id, 'runtime_offline') // → attempt row (adapter) + pg-boss auto-retry
    requeued += 1
    if (cooldownMs > 0) throttled += 1
  }

  return { audited, requeued, throttled }
}
