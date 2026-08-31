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
 * 'liveness_killed')` — THE SWEEP'S OWN WORD, not an outage report. It used to write
 * `runtime_offline` here, and a card reading «среда исполнения недоступна» sent a person to
 * check a machine that had been alive the whole time: what went silent was the WORKER.
 * On the pg-boss backend this hands the SAME job row back to
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
 * ═══ ТИШИНА — НЕ СМЕРТЬ ═══════════════════════════════════════════════════════════════════════
 * Этот обход умел спрашивать только ЧАСЫ. Аренда продлевалась исключительно из потока вывода
 * (loop.mjs, touch внутри onLine), так что работник, думавший молча дольше срока аренды, был для
 * сторожа неотличим от повисшего процесса — и три попытки подряд честного молчания сгорели в
 * failed. Признака «ЖИВ ЛИ ПРОЦЕСС» у сторожа не было вовсе.
 *
 * Теперь он есть, и он приходит ТЕМ ЖЕ коллаборатором, что и ручка убийства: реестр отвечает
 * `true` / `false` / `null`. Отсюда три разных исхода вместо одного ярлыка:
 *   - процесс ЖИВ → аренда продлевается независимо от того, печатает он строки или молчит;
 *     сторож не трогает того, кто работает;
 *   - процесс МЁРТВ (ручка этого демона видела его конец) → `worker_process_gone`;
 *   - ручка НЕИЗВЕСТНА (чужая машина, переживший рестарт демон) → `liveness_killed`, ровно то
 *     слово, которым этот случай назывался и раньше.
 * Своего состояния сторож по-прежнему не заводит: он ничего не помнит между тиками, а демон,
 * собранный без реестра, подметает в точности как до этой правки — по часам, без пробника.
 *
 * И МОЛЧАНИЕ НЕ СТАНОВИТСЯ ВЕЧНЫМ. Продление по живому процессу без потолка означало бы, что
 * зацикленный ребёнок держит задачу столько, сколько живёт сам. Верхний предел жизни попытки —
 * MAX_ATTEMPT_LIFETIME_MS, одно число в одном месте (см. ниже), и по его достижении попытка
 * закрывается своим именем: `attempt_lifetime_exceeded`, а не «замолчала».
 *
 * ═══ ПРИГОВОР ЗАРАБАТЫВАЕТСЯ, А НЕ ОБЪЯВЛЯЕТСЯ ════════════════════════════════════════════════
 * Замерено 31.08: одна задача трижды подряд закрыта словом `liveness_killed` — и трижды её
 * процесс продолжал жить. На машине стояли ЧЕТЫРЕ работника разом, дом мест честно показывал
 * «4 из 4 занято», а доска — ни одной идущей задачи: строки были закрыты вердиктом, процессы
 * закрыты не были. «Умерла для учёта, жива для денег» — это и есть та форма, из-за которой одна
 * подписка горит в несколько потоков; снимать её пришлось руками, по одному PID.
 *
 * Отсюда два закона, и оба стоят ЗДЕСЬ, потому что здесь выносится вердикт:
 *
 *   (1) СНАЧАЛА ГАШЕНИЕ, ПОТОМ ПОДЪЁМ, И ГАШЕНИЕ ПРОВЕРЯЕТСЯ. Порядок «убить → перевыдать» был
 *       и раньше, но у него не было ВТОРОГО взгляда: остановку звали и верили ей на слово. Теперь
 *       после остановки сторож СМОТРИТ ещё раз (confirmProcessGone), и строка закрывается только
 *       тогда, когда процесс на этот взгляд уже не отвечает «жив». Пережил остановку — строка
 *       остаётся своей, задача НЕ перевыдаётся, а в журнал уходит `liveness.kill_unconfirmed`:
 *       следующий проход придёт и попробует снова. Пропущенная перевыдача стоит одного тика;
 *       закрытая строка при живом ребёнке стоит второго работника на ту же работу.
 *
 *   (2) ОТКАЗ ПРОБЫ — НЕ МОЛЧАНИЕ РАБОТНИКА. Сломанный пробник и молчащий работник — разные
 *       события с разной починкой, а в один ярлык их сводила одна строка кода: `catch → null`,
 *       и `null` читался «про процесс сказать нечего, судим по часам». 31.08 склад зависимостей
 *       был опустошён (соседняя работа), хелперы перестали запускаться — и обход, у которого
 *       проба падала, начал хоронить живых по часам, как будто пробника у него и не было. Теперь
 *       брошенная проба возвращает PROBE_BROKEN, и это НЕ повод для вердикта: сторож честно
 *       говорит `liveness.probe_unavailable` («прогон живости не состоялся») и не судит вовсе —
 *       до самого потолка жизни попытки, который остаётся единственным, что закрывает её без
 *       ответа пробы.
 *
 * Node built-ins only; `clock` and `sleep` are dependency-injected so the sweep is deterministic
 * in tests. No live Postgres — the adapter + ledger are injected fakes in the suite.
 */

import { DEFAULT_EXPIRE_MS } from './adapter.mjs'

const BASE_COOLDOWN_MS = 120000 // 120s
const MAX_COOLDOWN_MS = 1800000 // 30 min

/**
 * ВЕРХНИЙ ПРЕДЕЛ ЖИЗНИ ОДНОЙ ПОПЫТКИ — 4 часа, и это ОДНО число в ОДНОМ месте.
 *
 * Оно понадобилось ровно в ту минуту, когда живой процесс стал сам по себе основанием продлить
 * аренду: без потолка зацикленный ребёнок держал бы задачу столько, сколько живёт сам, и «не
 * убивать честное молчание» превратилось бы в «не убивать никогда».
 *
 * ПОЧЕМУ ЧЕТЫРЕ. Окно подписки — около пяти часов; попытка, которая в него не поместилась,
 * оставляет человеку не результат, а сгоревшее окно. Четыре часа — самая длинная честная работа,
 * после которой в том же окне ещё остаётся место на перевыдачу. Число называется в README (EN+RU)
 * и нигде не дублируется: срок аренды (DEFAULT_EXPIRE_MS) отвечает на другой вопрос — «как часто
 * подавать признаки жизни», а этот — «сколько всего живёт одна попытка».
 */
export const MAX_ATTEMPT_LIFETIME_MS = 4 * 60 * 60 * 1000 // 4 ч

/**
 * PROBE_BROKEN — ОТВЕТ «ПРОБА НЕ СОСТОЯЛАСЬ», И ОН ОДНО СЛОВО НА ВЕСЬ ПРОДУКТ.
 *
 * Пробник живости может ответить три вещи о процессе (жив / мёртв / не знаю) и ЧЕТВЁРТУЮ о себе:
 * «меня не спросить». Четвёртая раньше сливалась с «не знаю» — и обход, у которого сломался
 * пробник, продолжал судить по часам, ровно как обход без пробника вовсе. Разница между ними
 * решает судьбу живого работника, поэтому у неё есть собственное слово.
 *
 * Объявлено ЗДЕСЬ, у того, кто это слово читает, и импортируется реестром ручек, который его
 * произносит: одно написание на обоих концах провода — иначе однажды разойдутся именно они.
 */
export const PROBE_BROKEN = 'probe_broken'

/**
 * СКОЛЬКО СТОРОЖ СМОТРИТ, ДЕЙСТВИТЕЛЬНО ЛИ ПРОЦЕСС КОНЧИЛСЯ ПОСЛЕ ОСТАНОВКИ.
 *
 * Остановка — это просьба к ОС, а не факт: между `kill()` и концом процесса лежит доставка
 * сигнала, разматывание ребёнка и событие `exit`. Строка, закрытая в этом промежутке, — та самая
 * «мёртвая для учёта, живая для денег» попытка. Две секунды с шагом в 50 мс: обычный случай
 * укладывается в ОДИН взгляд без сна вовсе, а на стойкого ребёнка сторож не тратит тик — он
 * оставляет строку своей и приходит на следующем проходе.
 */
export const KILL_CONFIRM_WAIT_MS = 2000
/** Шаг взгляда. Мал настолько, что обычная смерть ребёнка стоит одного-двух взглядов. */
export const KILL_CONFIRM_POLL_MS = 50

/** Сон по умолчанию. Инжектируется, чтобы сьют проходил все взгляды, не тратя на них время. */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
 * probeProcess(attemptTurns, taskId) → true | false | PROBE_BROKEN | null — ЖИВ ЛИ ПРОЦЕСС.
 *
 * Вопрос задаётся ручке, и только ручке: своего реестра сторож не заводит (см. шапку), а по
 * часам живость не выводится — именно эта подмена и хоронила молчащих работников.
 *
 * `null` — ЭТО НЕ «МЁРТВ», и ни одна ветка обхода не смеет прочесть его так. Так отвечают два
 * случая, и оба означают одно: СПРОСИТЬ НЕ У КОГО. Реестра не подали вовсе; ручка принадлежит
 * другому демону (или демон пережил рестарт, и ручек у него не осталось). Демон, собранный без
 * реестра, получает `null` на каждую попытку и подметает в точности как до появления пробника —
 * по часам.
 *
 * `PROBE_BROKEN` — И ЭТО ТРЕТЬЕ, ОТДЕЛЬНОЕ ОТ `null`. Спросить было У КОГО, но проба не
 * состоялась: пробник бросил (31.08 — потому, что под ним исчез склад зависимостей). «Спросить
 * не у кого» и «спросил, и мне сломалось» ведут к разным решениям, и с этой правки обход их
 * различает: по первому он судит по часам, по второму не судит вовсе (см. шапку, закон 2).
 */
function probeProcess(attemptTurns, taskId) {
  if (!attemptTurns || typeof attemptTurns.alive !== 'function') return null
  try {
    const v = attemptTurns.alive(taskId)
    if (v === true) return true
    if (v === false) return false
    // Реестр умеет сказать про себя «меня не спросить» — это слово едет дальше как есть.
    if (v === PROBE_BROKEN) return PROBE_BROKEN
    return null
  } catch {
    // Пробник бросил ЗДЕСЬ. Это отказ ПРОБЫ, а не молчание РАБОТНИКА, и выдуманное «мёртв»
    // стоило бы человеку живой работы — ровно так три попытки подряд и сгорели 31.08.
    return PROBE_BROKEN
  }
}

/**
 * failReasonFor(processAlive, overCeiling) — ПРИГОВОР НАЗЫВАЕТСЯ СВОИМ ИМЕНЕМ, а не ярлыком.
 *
 * До появления пробника все случаи уезжали в карточку одним словом `liveness_killed` («молчала
 * дольше срока»), и человек не мог отличить упавший процесс от работника, который честно думал
 * молча. Теперь слово отвечает на вопрос «что именно случилось»:
 *
 *   - ПОТОЛОК ЖИЗНИ (`overCeiling`) → `attempt_lifetime_exceeded`, и он старше всех остальных
 *     слов: попытку остановили не за молчание и не за смерть, а за то, что она выбрала своё
 *     время. Починка у неё своя — потолок или размер задачи. Это единственная дорога, по
 *     которой сюда доходят ЖИВОЙ процесс и попытка с несостоявшейся пробой: обе ветки выше
 *     возвращают их работать, пока потолок не достигнут.
 *   - `false` → `worker_process_gone`: ручка ЭТОГО демона видела конец процесса. Это факт, а не
 *     догадка по тишине, и человеку он говорит «работник упал», а не «работник молчал».
 *   - `null`  → `liveness_killed`: про процесс сказать нечего, судим по часам — ровно тот
 *     случай, которым это слово и было; подпись у него не меняется.
 */
function failReasonFor(processAlive, overCeiling) {
  if (overCeiling) return 'attempt_lifetime_exceeded'
  if (processAlive === false) return 'worker_process_gone'
  return 'liveness_killed'
}

/**
 * confirmProcessGone({attemptTurns, taskId, sleep}) → true, когда процесс больше НЕ отвечает
 * «жив», и false, когда он пережил остановку и всё ещё жив на последнем взгляде.
 *
 * ПОЧЕМУ ВООБЩЕ СМОТРЯТ ВТОРОЙ РАЗ. `stop()` возвращает «ручка была и её дёрнули», а не «процесс
 * кончился»: между просьбой и смертью лежит доставка сигнала и разматывание ребёнка. 31.08 три
 * строки подряд закрылись в этом промежутке, и за каждой осталась живая сессия, жгущая подписку.
 *
 * ЧТО СЧИТАЕТСЯ ПОДТВЕРЖДЕНИЕМ, И ПОЧЕМУ ИМЕННО ТАК. Единственный ответ, который ОСТАНАВЛИВАЕТ
 * приговор, — прямое `true`: «я вижу его живым». Всё остальное («мёртв», «спросить не у кого»,
 * «проба сломалась») подтверждением не является, но и держать строку вечно не может — иначе
 * демон без реестра, у которого ответ всегда `null`, перестал бы подметать вовсе, а это и есть
 * работа этого файла. Так что порог здесь один и он узкий: не закрываем строку, ПОКА ВИДИМ
 * живого. Утверждать по этому взгляду, что процесс мёртв, никто не смеет — что стало с процессом,
 * говорит отдельная строка журнала.
 */
async function confirmProcessGone({ attemptTurns, taskId, sleep }) {
  const looks = Math.max(1, Math.ceil(KILL_CONFIRM_WAIT_MS / KILL_CONFIRM_POLL_MS))
  for (let i = 0; i < looks; i += 1) {
    if (probeProcess(attemptTurns, taskId) !== true) return true // первый взгляд — без сна вовсе
    try {
      await sleep(KILL_CONFIRM_POLL_MS)
    } catch {
      break // сон недоступен — смотрим последний раз и отвечаем честно, а не зависаем
    }
  }
  return probeProcess(attemptTurns, taskId) !== true
}

/**
 * livenessSweep({adapter, ledger, clock, expireMs, journal, attemptTurns}) — audit every non-terminal task
 * for a durable live path; requeue the ones that lost it. Returns a summary.
 *
 * A task is:
 *   - terminal (completed/failed) → not audited (no live-path obligation);
 *   - queued → OK (queued IS a durable live path);
 *   - active with a fresh renewal (now - leaseRenewedAt <= expireMs) → OK;
 *   - active with a STALE touch → no live path → adapter.fail(id, 'liveness_killed')
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
 * THE ORDER IS THE POINT: stop the child, MAKE SURE it stopped, SAY what came of stopping it,
 * then reissue the task. Reversed, it is the exact loop that once ran three processes against one
 * row — the row is closed while the child lives on, so the next tick sees a task with no live
 * path and starts yet another attempt. Замерено дважды: 12.08 в порядке «перевыдать, не убивая» и
 * 31.08 в порядке «убить, не проверив». Оба раза счёт вышел одинаковый — параллельные сессии на
 * одной подписке.
 *
 * ЧЕТЫРЕ ЧИСЛА В ОТВЕТЕ, А НЕ ДВА. `requeued` говорит, сколько строк закрыто; `renewed` — сколько
 * раз молчание признано работой; `probeBroken` — сколько раз сторож ОТКАЗАЛСЯ судить, потому что
 * не состоялась проба; `killUnconfirmed` — сколько раз он отказался закрыть строку, потому что
 * процесс пережил остановку. Последние два — это ровно те случаи, которые до сих пор были
 * неотличимы от обычной перевыдачи, и человек, глядя на сводку, не мог узнать о них ничего.
 *
 * @param {{adapter:object, ledger?:object, clock?:Function|number, expireMs?:number, journal?:Function, attemptTurns?:object, sleep?:Function}} opts
 * @returns {Promise<{audited:number, requeued:number, throttled:number, renewed:number, probeBroken:number, killUnconfirmed:number}>}
 */
export async function livenessSweep({
  adapter,
  ledger,
  clock = Date.now,
  expireMs = DEFAULT_EXPIRE_MS,
  journal,
  attemptTurns,
  sleep = defaultSleep,
} = {}) {
  if (!adapter || typeof adapter.list !== 'function' || typeof adapter.fail !== 'function') {
    throw new TypeError('livenessSweep requires an adapter with list() and fail()')
  }
  const now = () => (typeof clock === 'function' ? clock() : clock)
  const rows = await adapter.list({}) // durable read — never an in-memory registry
  let audited = 0
  let requeued = 0
  let throttled = 0
  // Продления по ЖИВОМУ процессу — отдельным числом: это единственное место, где видно, сколько
  // раз молчание было признано работой, а не смертью.
  let renewed = 0
  // …и два числа про ОТКАЗ СУДИТЬ. Оба означают «строка осталась своей», но по разным причинам,
  // и сливать их значило бы снова потерять разницу между сломанной пробой и выжившим процессом.
  let probeBroken = 0
  let killUnconfirmed = 0

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

    // ── ТИШИНА ЕСТЬ. ТЕПЕРЬ ВОПРОС — ЖИВ ЛИ ТОТ, КТО МОЛЧИТ.
    // Ответ спрашивается у ручки, а не выводится из часов: `true` — процесс на месте, `false` —
    // этот демон видел его конец, `null` — спросить не у кого (реестра нет, ручки нет),
    // PROBE_BROKEN — спросить было у кого, но проба не состоялась. Ни одна ветка ниже не
    // превращает `null` в «мёртв» и ни одна не судит по PROBE_BROKEN.
    const processAlive = probeProcess(attemptTurns, r.id)
    const silentMs = now() - lastTouch
    const lifetimeMs = now() - (r.claimedAt ?? lastTouch)
    // ПОТОЛОК ЖИЗНИ ПОПЫТКИ — ОДНО УСЛОВИЕ НА ВСЕ ВЕТКИ НИЖЕ. Он единственный, что закрывает
    // попытку без ответа пробы: и живому, и неспрошенному он ставит один и тот же предел.
    const overCeiling = lifetimeMs > MAX_ATTEMPT_LIFETIME_MS

    // ── ЖИВОЙ МОЛЧУН: АРЕНДА ПРОДЛЕВАЕТСЯ, И ЭТО ВЕСЬ ОТВЕТ.
    // Пока процесс жив и попытка не переросла свой верхний предел, вывод не имеет значения:
    // работник, думающий молча, — это работающий работник. Продление идёт через ту же дверь
    // очереди, что и продление из потока (`touch`), и БЕЗ жетона: жетон выдан работнику, а
    // сторож здесь свидетель живости, а не участник попытки.
    if (processAlive === true && !overCeiling) {
      let renewedOk = false
      if (typeof adapter.touch === 'function') {
        try {
          renewedOk = (await adapter.touch(r.id)) !== false
        } catch {
          renewedOk = false // продлить не вышло — но живого за это не убивают
        }
      }
      if (typeof journal === 'function') {
        try {
          journal({
            type: 'liveness.lease_renewed_alive',
            taskId: r.id,
            attempt: r.attempt ?? null,
            silentMs,
            lifetimeMs,
            renewed: renewedOk,
            detail:
              `попытка ${r.attempt ?? '?'} задачи ${r.id} молчит ${Math.round(silentMs / 1000)} с, но её процесс ЖИВ — ` +
              (renewedOk ? 'аренда продлена' : 'продлить аренду не удалось') +
              `; идёт ${Math.round(lifetimeMs / 60000)} мин при пределе ${Math.round(MAX_ATTEMPT_LIFETIME_MS / 60000)} мин.`,
          })
        } catch {
          /* повествование никогда не стоит задачи */
        }
      }
      renewed += 1
      continue
    }

    // ── ПРОБА НЕ СОСТОЯЛАСЬ — И ЭТО НЕ ПРИГОВОР, А ОТКАЗ СУДИТЬ.
    // Отказ ПРОБЫ и молчание РАБОТНИКА — разные события (шапка, закон 2). Про этот процесс не
    // сказано ничего: ни что он жив, ни что он мёртв, — сказано лишь, что спросивший сломался.
    // Хоронить по такому ответу значит хоронить наугад, а наугад здесь стоит живой сессии и
    // сгоревшего окна. Строка остаётся своей, аренда НЕ продлевается (продлевать нечем: живости
    // никто не подтвердил), и попытка доживает до потолка — единственного, что закроет её без
    // ответа пробы. Следующий проход спросит снова; починившийся пробник вернёт всё в норму сам.
    if (processAlive === PROBE_BROKEN && !overCeiling) {
      if (typeof journal === 'function') {
        try {
          journal({
            type: 'liveness.probe_unavailable',
            taskId: r.id,
            attempt: r.attempt ?? null,
            silentMs,
            lifetimeMs,
            detail:
              `попытка ${r.attempt ?? '?'} задачи ${r.id}: проба живости НЕ СОСТОЯЛАСЬ — пробник бросил, ` +
              `про процесс не известно ничего. Молчит ${Math.round(silentMs / 1000)} с, идёт ` +
              `${Math.round(lifetimeMs / 60000)} мин при пределе ${Math.round(MAX_ATTEMPT_LIFETIME_MS / 60000)} мин; ` +
              'приговор НЕ выносится — сломанная проба это не молчание работника.',
          })
        } catch {
          /* повествование никогда не стоит задачи */
        }
      }
      probeBroken += 1
      continue
    }

    // ── ПРИГОВОР. СНАЧАЛА ГАШЕНИЕ И ЕГО ПОДТВЕРЖДЕНИЕ, И ТОЛЬКО ПОТОМ СЛОВА.
    //
    // (а) УБИТЬ. Чужой ручкой: реестр приходит коллаборатором, как и журнал, и своего состояния
    // сторож не заводит — иначе перезапуск демона перестанет быть бесплатным, а весь этот файл
    // написан ровно ради того, чтобы демон был убиваем на любой строке. Ручка адресуется
    // идентификатором ЗАДАЧИ: второго способа дотянуться до процесса здесь нет, и заводить его
    // значило бы открыть путь к убийству не того ребёнка.
    // `null` — это «не спрашивали или ответ неизвестен», и это НЕ ветка исхода.
    const reason = failReasonFor(processAlive, overCeiling)
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
    // (а2) УБЕДИТЬСЯ, ЧТО УБИЛИ. `stop()` отвечает «ручка была и её дёрнули», а не «процесс
    // кончился». Строка, закрытая в промежутке между просьбой и смертью, — это «умерла для
    // учёта, жива для денег»: 31.08 так закрылись три строки, и за каждой осталась живая
    // сессия. Видим живого после остановки — НЕ ЗАКРЫВАЕМ строку вовсе: место остаётся занятым
    // тем, кто его правда занимает, доска не расходится с машиной, а следующий проход придёт и
    // попробует снова.
    if (killed === true && !(await confirmProcessGone({ attemptTurns, taskId: r.id, sleep }))) {
      if (typeof journal === 'function') {
        try {
          journal({
            type: 'liveness.kill_unconfirmed',
            taskId: r.id,
            attempt: r.attempt ?? null,
            reason,
            silentMs,
            lifetimeMs,
            detail:
              `попытка ${r.attempt ?? '?'} задачи ${r.id}: остановка вызвана (${reason}), но процесс ЖИВ и ` +
              `через ${Math.round(KILL_CONFIRM_WAIT_MS / 1000)} с после неё. Задача НЕ перевыдана: закрытая ` +
              'строка при живом процессе даёт второго работника на ту же работу. Следующий проход повторит.',
          })
        } catch {
          /* повествование никогда не стоит задачи */
        }
      }
      killUnconfirmed += 1
      continue
    }

    // Stale active AND nothing alive behind it (or a life that outgrew its ceiling) — no durable
    // live path. Requeue it, and NAME which of the three it was.
    const prior = ledger && typeof ledger.readAttempts === 'function' ? ledger.readAttempts(r.id) : []
    const noProgress = countNoProgress(prior) + 1 // this failure
    const cooldownMs = computeCooldownMs(noProgress)
    // THE ONE LINE (see the header) — written BEFORE the declaration and fail-open. It states the
    // DECISION, and it is written only once the decision may actually be carried out: a line
    // saying «объявлена мёртвой» above a row that stays open would be a lie in the log, and the
    // log of this sweep is what an investigation of a burnt night is run on.
    if (typeof journal === 'function') {
      try {
        journal({
          type: 'liveness.attempt_dead',
          taskId: r.id,
          attempt: r.attempt ?? null,
          silentMs,
          lifetimeMs,
          expireMs,
          reason, // ПОЧЕМУ ИМЕННО, а не «сторож сработал»: слово то же, что уедет в строку попытки
          noProgressRuns: noProgress,
          cooldownMs,
          detail:
            `попытка ${r.attempt ?? '?'} задачи ${r.id} объявлена мёртвой (${reason}): ` +
            (overCeiling
              ? `попытка идёт ${Math.round(lifetimeMs / 60000)} мин при верхнем пределе ` +
                `${Math.round(MAX_ATTEMPT_LIFETIME_MS / 60000)} мин` +
                (processAlive === true
                  ? ', процесс ещё жив'
                  : processAlive === PROBE_BROKEN
                    ? ', и проба живости так и не состоялась'
                    : '')
              : processAlive === false
                ? 'её процесс завершился, ручка этого демона видела конец'
                : `молчит ${Math.round(silentMs / 1000)} с при сроке ${Math.round(expireMs / 1000)} с, ` +
                  'ручки этому демону не известно') +
            '; задача перевыдана в очередь' +
            (cooldownMs > 0 ? `, остывание ${Math.round(cooldownMs / 1000)} с` : '') +
            '. Что стало с процессом — отдельной строкой ниже.',
        })
      } catch {
        /* повествование никогда не стоит задачи */
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
                  'дочерний процесс остановлен ДО того, как задача перевыдана в очередь, и на ' +
                  'повторном взгляде он живым уже не отвечает.',
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
    // ── (в) ПЕРЕВЫДАТЬ. Только теперь: обратный порядок закрывает строку при живом ребёнке, и
    // только после того, как гашение ПОДТВЕРЖДЕНО — вызванная остановка сама по себе никогда не
    // была основанием закрыть строку.
    //
    // ЖЕТОНА ПОПЫТКИ ЗДЕСЬ НЕТ — И ЭТО РЕШЕНИЕ, А НЕ ЗАБЫТЫЙ АРГУМЕНТ. Жетон выдаётся тому,
    // КТО ЗАХВАТИЛ задачу, и служит одному: работник не смеет закрыть попытку, которая уже
    // не его. Сторож живости задачу не захватывал и работником не является — он отбирает её
    // у замолчавшего ПРАВОМ ВЛАСТИ, ровно потому, что предъявить жетон больше некому: тот,
    // у кого он был, мёртв или недостижим. Потребуй мы жетона и здесь, замолчавшая попытка
    // осталась бы висеть навсегда, а именно её перевыдача — весь смысл этого обхода.
    // Очередь такой вызов принимает намеренно: непредъявленный жетон у неё — не отказ.
    //
    // И ПРИГОВОР НАЗЫВАЕТСЯ СВОИМ ИМЕНЕМ — ТЕМ, КОТОРОЕ ВЫБРАЛ `failReasonFor`, а не зашитым
    // здесь одним на все случаи. Раньше в очередь уезжало `liveness_killed` независимо от того,
    // что стало с процессом, и «работник упал» было для человека неотличимо от «работник молчал».
    // Слово ТО ЖЕ, что ушло в строку журнала выше: одна свёртка — один приговор, и карточка не
    // может разойтись с логом.
    //
    // `runtime_offline` не участвует ни в одной из трёх веток: среда была жива, молчал работник,
    // и карточка «среда исполнения недоступна» отправляла человека чинить машину, с которой
    // ничего не случилось. Это слово остаётся за настоящей недоступностью среды — её называет
    // тик, когда процесс не удалось даже запустить.
    await adapter.fail(r.id, reason) // → attempt row (adapter) + pg-boss auto-retry
    requeued += 1
    if (cooldownMs > 0) throttled += 1
  }

  return { audited, requeued, throttled, renewed, probeBroken, killUnconfirmed }
}
