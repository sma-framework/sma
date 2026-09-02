/**
 * in-flight.mjs — КТО ПРЯМО СЕЙЧАС РАБОТАЕТ, и сколько мест осталось.
 *
 * WHY THIS EXISTS AT ALL. The tick is started by a timer and called WITHOUT waiting for the
 * previous pass to finish, while every pass claims a task and walks it to the end. So attempts
 * overlap by construction — and until now nothing anywhere counted them: a search of the whole
 * daemon for a concurrency counter, a semaphore or an in-flight marker returned nothing. This
 * is the floor under the 12.08.2026 incident, where three parallel processes burned one
 * subscription while the board showed an empty queue and a free worker.
 *
 * WHY THE SEAT IS TAKEN BEFORE THE CLAIM, AND SYNCHRONOUSLY. This is the whole design, and the
 * first version of it was wrong: it counted the seat AFTER the claim. A claim is an await, so
 * two overlapping ticks would BOTH see an empty house, both pass the ceiling and both take a
 * task — the exact thing the ceiling exists to prevent. `reserve()` checks and takes in one
 * synchronous step, with no await inside, so the second tick finds the house full even though
 * the first has not reached its task yet.
 *
 * WHY IT LIVES IN ITS OWN FILE. The tick file is held stateless BY A GATE (`loop.mjs` may not
 * hold an in-process keyed collection, and the gate greps for one). That rule is right: state
 * that creeps into the tick is state nobody can reason about across passes. So the house that
 * remembers lives here, and the tick only ever asks it.
 *
 * WHY IT IS MEMORY AND NOT A QUEUE ROW. What is counted is «children THIS daemon process has
 * alive right now». No durable row can answer that honestly — a row says a task is active, not
 * that a process still exists. Memory dies with the process, and that is exactly correct: a
 * daemon that restarted has no children, so its house starts empty and its ceiling is free.
 *
 * WHY THE CEILING IS READ HERE TOO. The house is asked for both numbers a person needs — how
 * many seats there are and how many are taken — so it is the house that says what the ceiling
 * IS. The reading used to live in the tick, where it was reachable by nobody else: the screen
 * that wanted to state «занято X из N» would have had to spell the setting a second time, and
 * two spellings of one number is how a screen ends up disagreeing with the machine it watches.
 *
 * ── МЕСТО ДЕРЖИТ ЖИВОЙ ПРОЦЕСС, А НЕ ПРОХОД ТИКА ───────────────────────────────────────────
 *
 * Первая редакция отдавала место ТОЛЬКО в последнем `finally` прохода, то есть после смерти
 * ребёнка держала его ещё столько, сколько идут ворота: переповерка, квитанция, коммиты, свод.
 * Замерено на живом дне: две попытки сняты дверью отмены (дверь ответила «попытка закрылась»),
 * процессы добиты, в системе не осталось НИ ОДНОГО — а тик три минуты подряд писал «идущих
 * попыток 4 при потолке 4» и не брал ни одной из пяти строк очереди при свободном работнике.
 * «Попытка закрылась» в ответе двери и «идущих попыток» в тике были ДВА РАЗНЫХ СЧЁТА одного
 * факта, и разошлись они ровно там, где это стоило конвейера.
 *
 * Поэтому счёт здесь один и он назван: место занимает ЖИВОЙ РЕБЁНОК, и отдаётся оно в момент
 * ПОДТВЕРЖДЁННОЙ его смерти — тем же выражением (`confirmProcessGone`), которым дверь отмены
 * отвечает человеку «попытка закрылась». Одно выражение, два потребителя: разойтись нечему.
 * Последний `finally` прохода остаётся на месте и остаётся правым — он ловит выходы, у которых
 * ребёнка не было вовсе, — но он больше не единственная дорога к свободному месту.
 */

import { isOrchestrator } from '../policy/orchestrator.mjs'

/**
 * СКОЛЬКО ПОПЫТОК ЭТОТ ДЕМОН ВЕДЁТ ОДНОВРЕМЕННО. Умолчание — ОДНА, и это осознанно: до сих пор
 * потолка не было вовсе, а единственная известная авария этого класса стоила трёх параллельных
 * процессов на одну подписку. У кого работников несколько и они не мешают друг другу — поднимает
 * число настройкой; молчание настройки означает безопасный пол, а не «сколько получится».
 *
 * ОДНО ЧТЕНИЕ НА ВЕСЬ ДЕМОН. Тик спрашивает его перед тем, как взять место; дверь состояния —
 * чтобы назвать человеку общее число мест. Настройка, прочитанная в двух местах, однажды
 * читается по-разному, и разойдутся ровно потолок и его подпись на экране.
 *
 * @param {object} config
 * @returns {number} потолок мест, минимум 1
 */
export function concurrencyCap(config) {
  const raw = Number(config && config.maxConcurrentAttempts)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1
}

/**
 * СКОЛЬКО РАБОТНИКОВ ВООБЩЕ МОГУТ ДЕРЖАТЬ ПОПЫТКУ — включённые, кроме верхушки.
 *
 * ЗАЧЕМ ЭТО ЧИСЛО РЯДОМ С ПОТОЛКОМ. Потолок отвечает на вопрос «сколько попыток этот демон
 * ведёт разом», и до сих пор он был ЕДИНСТВЕННЫМ условием захвата. Но попытку кто-то должен
 * вести: работников трое, потолок четыре — и четвёртая строка бралась при всех занятых, потому
 * что мест по потолку ещё оставалось. Дальше её ждал маршрут, у которого свободного работника
 * уже не было, и старая дорога отдавала строку ЗАНЯТОМУ. Это не гонка: при потолке больше числа
 * работников так происходит ВСЕГДА.
 *
 * ВЕРХУШКА НЕ СЧИТАЕТСЯ — тем же выражением и по той же причине, что и в фильтре маршрутизатора:
 * оркестратор задач из очереди не берёт ни при каком порядке строк конфига. Роль здесь НЕ
 * спрашивается: до захвата задачи нет, а значит нет и слова о роли; специалист, поднятый ролью,
 * держит место так же, как исполнитель.
 *
 * @param {object} config
 * @returns {number|null} число работников, или null — списка нет, считать нечего
 */
export function workerSeats(config) {
  const list = seatWorkers(config)
  return list == null ? null : list.length
}

/**
 * КТО ИМЕННО МОЖЕТ ДЕРЖАТЬ ПОПЫТКУ — те же работники, поимённо.
 *
 * ОДНО СЛОВО «КТО РАБОТНИК», А НЕ ДВА. Счёт мест выше и проверка «все ли уже заняты» в тике
 * задают ОДИН вопрос, и до этой функции отвечали на него по-разному: счёт вычитал верхушку, а
 * проверка занятости считала её обычным работником — то есть ждала, пока попытку возьмёт тот,
 * кто задач не берёт вовсе, и потому не срабатывала никогда. Число и список обязаны выходить из
 * одного выражения: разойдясь, они разойдутся молча и в разные стороны.
 *
 * `null` — «списка нет, считать нечего» (см. fail-open у seatCeiling); пустой массив невозможен
 * по построению: список из одних выключенных даёт пустой ответ, а не молчание.
 *
 * @param {object} config
 * @returns {object[]|null} работники, способные держать попытку, или null — списка нет
 */
export function seatWorkers(config) {
  const list = config && Array.isArray(config.workers) ? config.workers : null
  if (!list || list.length === 0) return null
  return list.filter((w) => w && w.enabled !== false && !isOrchestrator(w))
}

/**
 * СКОЛЬКО МЕСТ ЭТОТ ДЕМОН МОЖЕТ ЗАНЯТЬ ПРЯМО СЕЙЧАС — меньшее из двух ограничителей.
 *
 * FAIL-OPEN НА МОЛЧАНИИ СПИСКА: конфиг без работников (так собран не один сборочный шов) отвечает
 * прежним потолком, а не нулём. Пустой список — это «сказать нечем», и остановленный из-за него
 * конвейер стоил бы дороже, чем не сработавший второй ограничитель.
 *
 * @param {object} config
 * @returns {number} потолок мест этого прохода
 */
export function seatCeiling(config) {
  const cap = concurrencyCap(config)
  const byWorkers = workerSeats(config)
  return byWorkers == null ? cap : Math.min(cap, byWorkers)
}

/**
 * createInFlight() → the house of running attempts.
 *
 * The seat is taken by `reserve(cap)` BEFORE the claim, named with the task (and then the
 * worker) as those become known, and given back by `release(token)` from a `finally` no exit
 * path can skip — a leaked seat would freeze the conveyor silently, which is worse than having
 * no ceiling at all.
 *
 * @returns {{
 *   size:()=>number,
 *   workers:()=>Set<string>,
 *   held:()=>Array<{taskId:string|null, workerId:string|null}>,
 *   reserve:(cap:number)=>string|null,
 *   name:(token:string, taskId:string|null, workerId?:string|null)=>void,
 *   release:(token:string)=>void,
 *   releaseTask:(taskId:string)=>boolean,
 * }}
 */
export function createInFlight() {
  const seats = new Map() // token → {taskId, workerId}
  let counter = 0
  return {
    size: () => seats.size,
    workers: () =>
      new Set([...seats.values()].map((s) => s && s.workerId).filter((id) => typeof id === 'string' && id !== '')),
    /**
     * КТО СИДИТ В МЕСТАХ — поимённо, тем же одним чтением, каким называется их число.
     *
     * Доска говорила «мест занято 4» рядом со списком, в котором работали двое, и объяснить
     * разницу было НЕЧЕМ: число приходило от дома, список — от карточек, и человек читал
     * расхождение как ошибку экрана. Оно ошибкой не было — за двумя лишними местами стояли
     * живые сессии, не привязанные ни к одной карточке. Список занятых мест делает их видимыми:
     * счёт и состав приезжают из ОДНОГО источника, поэтому расходиться им негде, а попытка,
     * которую не показывает ни одна карточка, называется вслух вместо того, чтобы прятаться в
     * разнице двух чисел.
     */
    held: () => [...seats.values()].map((s) => ({ taskId: s.taskId ?? null, workerId: s.workerId ?? null })),
    /** Check and take in ONE synchronous step — null means the house is full. */
    reserve(cap) {
      const ceiling = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 1
      if (seats.size >= ceiling) return null
      counter += 1
      const token = `seat-${counter}`
      seats.set(token, { taskId: null, workerId: null })
      return token
    },
    /** Say WHO is in the seat, once the claim and then the route have answered. */
    name(token, taskId, workerId = null) {
      const seat = seats.get(token)
      if (!seat) return
      if (typeof taskId === 'string' && taskId !== '') seat.taskId = taskId
      if (typeof workerId === 'string' && workerId !== '') seat.workerId = workerId
    },
    release(token) {
      if (typeof token === 'string') seats.delete(token)
    },
    /**
     * ОТДАТЬ МЕСТО ПО ИМЕНИ ЗАДАЧИ — дорога для того, кто жетона места не держит.
     *
     * Жетон знает только проход, который место взял; смерть же ребёнка подтверждает дверь
     * отмены, у которой на руках одно имя задачи. Без этой дороги дверь могла бы честно
     * ответить «попытка закрылась» и не иметь ни одного способа сообщить об этом дому — что и
     * произошло. Идемпотентно: отдать уже отданное место — не ошибка, а обычный порядок вещей,
     * потому что тот же `finally` прохода отдаст его вторым разом.
     */
    releaseTask(taskId) {
      if (typeof taskId !== 'string' || taskId === '') return false
      let freed = false
      for (const [token, seat] of seats) {
        if (seat && seat.taskId === taskId) {
          seats.delete(token)
          freed = true
        }
      }
      return freed
    },
  }
}

/**
 * confirmProcessGone(deps, taskId) → ПОДТВЕРЖДЕНА ЛИ СМЕРТЬ РЕБЁНКА этой попытки; и, тем же
 * выражением, место этой попытки отдаётся дому.
 *
 * ПОЧЕМУ ОДНО ВЫРАЖЕНИЕ, А НЕ ДВА СОГЛАСОВАННЫХ. Дверь отмены отвечала человеку «попытка
 * закрылась», тик считал ту же попытку идущей, и оба были уверены в своём: наблюдение было
 * одно и то же, но написано дважды, в двух файлах, и одно из двух написание про место просто
 * не знало. Пока факт называется в одном месте и это же место распоряжается последствием,
 * разойтись двум ответам негде.
 *
 * ЧТО СЧИТАЕТСЯ ПОДТВЕРЖДЕНИЕМ, и почему именно это. Реестр ручек держит ЖИВЫЕ ручки: свою
 * запись стирает выходная дорога самого ребёнка. Значит ручки нет — попытка размоталась. А
 * ручка, чей пробник отвечает «процесс не жив», — это попытка, которая УЖЕ мертва, хотя проход
 * ещё идёт своими воротами; ровно этот случай и держал место три минуты после смерти. Оба
 * ответа — подтверждения, и оба ведут к одному последствию.
 *
 * ЧТО ПОДТВЕРЖДЕНИЕМ НЕ СЧИТАЕТСЯ. Молчание. Пробник, которого нет, и пробник, который сам
 * сломался, отвечают «сказать нечего» — и по такому ответу место не отдаётся никогда: место,
 * отданное под живым процессом, — это второй процесс на ту же подписку, то есть ровно та
 * авария, ради которой потолок и заведён. Поэтому спрашивающий обязан знать, что ребёнок БЫЛ:
 * дверь отмены спрашивает только после удавшегося убийства, тик — только после того, как его
 * собственный запуск вернулся.
 *
 * @param {{attemptTurns?:object, inFlight?:object}} deps — те же зависимости, что у двери и у тика
 * @param {string} taskId
 * @returns {boolean}
 */
export function confirmProcessGone(deps, taskId) {
  const registry = deps && deps.attemptTurns
  if (!registry) return false
  const probe = typeof registry.alive === 'function' ? registry.alive(taskId) : null
  // Ручка есть и её пробник называет смерть — подтверждение, не дожидаясь размотки прохода.
  // Ручки нет вовсе — её стёрла выходная дорога ребёнка, то есть попытка уже кончилась.
  const gone =
    probe === false ||
    (typeof registry.has === 'function'
      ? registry.has(taskId) !== true
      : // Реестр без вопроса «есть ли ручка» — старое наблюдение двери: пока запись помечена
        // остановленной, попытка ещё разматывается; исчезла пометка — исчезла и запись.
        typeof registry.wasStopped === 'function' && registry.wasStopped(taskId) !== true)
  if (gone && deps.inFlight && typeof deps.inFlight.releaseTask === 'function') deps.inFlight.releaseTask(taskId)
  return gone
}
