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
 *
 * ── А ЗАНЯТОСТЬ РАБОТНИКА — ЭТО ВТОРОЙ СЧЁТ, И ОН ДЛИННЕЕ ──────────────────────────────────
 *
 * Карта мест была двойного назначения: ею же отвечали на вопрос «все ли работники заняты». Пока
 * место жило до конца прохода, два ответа совпадали. Как только место стало отдаваться на смерти
 * ребёнка, они разошлись — и разошлись в опасную сторону: между смертью ребёнка и концом ворот
 * (маркер, квитанция, переповерка, коммиты, свод — минуты) работник переставал числиться занятым,
 * а тик заводится таймером и НЕ ЖДЁТ конца предыдущего прохода. Ближайший тик выдавал тому же
 * работнику вторую задачу, пока первая ещё коммитила его же копию.
 *
 * Поэтому счётов ДВА, и каждый отвечает на свой вопрос. Место (`seats`) — про живого ребёнка и
 * про потолок: сколько процессов этот демон жжёт прямо сейчас. Занятость (`busy`) — про человека
 * за работой: она берётся, когда маршрут назвал работника, и отдаётся ТОЛЬКО последним `finally`
 * прохода, то есть после ворот. Один жетон держит обе записи, поэтому третьего счёта не заводится
 * и разойтись им негде: `release(token)` снимает обе, `releaseAttempt` — только место.
 */

import { isOrchestrator } from '../policy/orchestrator.mjs'
// СЛОВАРЬ ПОЛОС БЕРЁТСЯ ТАМ, ГДЕ ОН ОБЪЯВЛЕН, а не переписывается сюда: место, закреплённое за
// полосой, которой не бывает, — это место, которое не займёт никто и никогда, то есть тихо
// потерянная единица потолка. Опечатка в настройке обязана быть безвредной, а не дорогой.
import { TASK_LANES } from './adapter.mjs'

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
 * ЗА КАКОЙ ПОЛОСОЙ ЗАКРЕПЛЕНО СВОЁ МЕСТО — и почему без этого разведение по полосам было именем.
 *
 * ЗАМЕРЕНО НА ЖИВОМ ЗАПУСКЕ. Мест `maxConcurrentAttempts` — ОДНО ЧИСЛО НА МАШИНУ, общее для всех
 * полос. Четыре места держала полоса продукта, работник канцелярской полосы стоял свободным, а
 * ступень фазы — работа, которой этот работник и занимается, — не могла начаться ни при каком
 * приоритете: мест не осталось. Полосы были разведены по РАБОТНИКАМ и не разведены по МЕСТАМ,
 * то есть свободный работник другой полосы не значил ровно ничего.
 *
 * УМОЛЧАНИЕ — ОДНО МЕСТО КАНЦЕЛЯРСКОЙ ПОЛОСЕ, и это осознанная плата: пока её место свободно,
 * общий пул на единицу меньше потолка. Полоса эта — дорога ступеней фазы, самой крупной
 * структурной работы дома; час простоя одного места дешевле дня, на который отъезжает фаза.
 * Настройка `laneSeats` перебивает умолчание целиком, и `laneSeats: {}` — это «ничего не
 * закреплять», прежнее поведение слово в слово.
 *
 * ТРИ ПРЕДОХРАНИТЕЛЯ. При потолке меньше двух не закрепляется ничего — делить нечего, а машина
 * с одним местом, отданным полосе, перестала бы брать работу вовсе. Общий пул никогда не
 * пустеет: полосам достаётся не больше `потолок − 1`, сколько бы им ни назначили. И — главное —
 * ЗАКРЕПЛЕНИЕ ЖИВЁТ, ПОКА ПОЛОСЕ ЕСТЬ КЕМ РАБОТАТЬ: место, придержанное для полосы, на которой
 * ни один работник не может взять работу, — это просто потерянная единица потолка. Какие полосы
 * сейчас рабочие, знает ТИК (он выводит это маршрутом, единственным владельцем правила «кто
 * может взять»), и он передаёт список сюда; своё второе мнение о работоспособности полосы здесь
 * было бы копией маршрутизатора. Список не передан — не фильтруем: чтение настройки как таковой
 * (о нём спрашивают дела и экраны) не обязано знать, кто включён в эту секунду.
 *
 * @param {object} config
 * @param {string[]|null} [workingLanes] полосы, на которых прямо сейчас есть кому работать
 * @returns {Map<string, number>} полоса → сколько мест закреплено; пустая карта — не закреплено ничего
 */
export function laneReservations(config, workingLanes = null) {
  const ceiling = seatCeiling(config)
  const out = new Map()
  if (ceiling < 2) return out
  const named = config && config.laneSeats
  const table = named && typeof named === 'object' && !Array.isArray(named) ? named : LANE_SEATS_DEFAULT
  const working = Array.isArray(workingLanes) ? workingLanes : null
  let taken = 0
  for (const lane of TASK_LANES) {
    if (!Object.prototype.hasOwnProperty.call(table, lane)) continue
    if (working && !working.includes(lane)) continue
    const want = Math.floor(Number(table[lane]))
    if (!Number.isFinite(want) || want < 1) continue
    const room = ceiling - 1 - taken
    if (room <= 0) break
    const take = Math.min(want, room)
    out.set(lane, take)
    taken += take
  }
  return out
}

/** Умолчание закрепления: одно место полосе, которой едут ступени фазы. */
const LANE_SEATS_DEFAULT = Object.freeze({ paperwork: 1 })

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
 *   reserve:(cap:number, opts?:{reserved?:Map<string,number>, lane?:string|null})=>string|null,
 *   name:(token:string, taskId:string|null, workerId?:string|null, attemptId?:string|null, lane?:string|null)=>void,
 *   release:(token:string)=>void,
 *   releaseAttempt:(attemptId:string)=>boolean,
 * }}
 */
export function createInFlight() {
  const seats = new Map() // token → {taskId, attemptId, workerId} — ЖИВЫЕ дети, ими держится потолок
  const busy = new Map() // token → {taskId, workerId} — работник за работой, до конца ворот попытки
  let counter = 0
  return {
    size: () => seats.size,
    /**
     * КТО ИЗ РАБОТНИКОВ СЕЙЧАС ВЕДЁТ ПОПЫТКУ — и «ведёт» здесь длиннее, чем «жжёт процесс».
     *
     * Читается из ВТОРОЙ карты, а не из мест, и это вся разница между «работник свободен» и
     * «ребёнка больше нет». Ворота попытки — коммиты, свод, сдача — идут минутами после смерти
     * ребёнка, в его же копии и его же ветке; работник, отпущенный на этой границе, получал от
     * ближайшего тика вторую задачу поверх первой, ещё не закрытой.
     */
    workers: () =>
      new Set([...busy.values()].map((s) => s && s.workerId).filter((id) => typeof id === 'string' && id !== '')),
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
    /**
     * Check and take in ONE synchronous step — null means the house is full.
     *
     * ── И ЧЬЁ ЭТО МЕСТО, КОГДА У ПОЛОСЫ ЕСТЬ СВОЁ ──────────────────────────────────────────
     *
     * `reserve(cap)` — прежний вызов и прежний смысл: место из ОБЩЕГО пула. Когда за полосами
     * закреплены места (`laneReservations`), общий пул кончается раньше потолка: за каждой
     * полосой держится её место, пока она сама его не заняла. Тик, получивший отказ, спрашивает
     * ВТОРЫМ вызовом — `reserve(cap, {reserved, lane})` — и берёт место ИМЕНЕМ ПОЛОСЫ, после
     * чего обязан ограничить захват этой же полосой: место, закреплённое за канцелярией и
     * отданное продукту, — это отсутствие закрепления, написанное длиннее.
     *
     * Жёсткий потолок стоит выше всего: сколько бы мест ни было закреплено, `seats.size` не
     * переходит `cap` ни на одном пути. Закрепление ПЕРЕРАСПРЕДЕЛЯЕТ места, а не добавляет их —
     * иначе это был бы обход потолка, ради которого он и заведён.
     *
     * @param {number} cap потолок мест
     * @param {{reserved?:Map<string,number>, lane?:string|null}} [opts]
     * @returns {string|null}
     */
    reserve(cap, opts = {}) {
      const ceiling = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 1
      if (seats.size >= ceiling) return null
      const reserved = opts && opts.reserved instanceof Map ? opts.reserved : null
      const lane = opts && typeof opts.lane === 'string' && opts.lane !== '' ? opts.lane : null
      const heldBy = (l) => [...seats.values()].filter((s) => s && s.lane === l).length
      if (lane === null) {
        // ОБЩИЙ ПУЛ: за каждой полосой держится столько мест, сколько ей закреплено и сколько
        // она ещё не заняла сама. Место, взятое до захвата, полосы пока не называет — такое
        // место считается общим, и общий пул от этого только осторожнее, а не смелее.
        let heldBack = 0
        if (reserved) for (const [l, n] of reserved) heldBack += Math.max(0, n - heldBy(l))
        if (seats.size >= ceiling - heldBack) return null
      } else {
        // МЕСТО ПОЛОСЫ: только её собственное и только пока оно свободно. Полосе, за которой
        // ничего не закреплено, отдельной дороги нет вовсе — она ходит общим пулом, как все.
        const own = reserved ? reserved.get(lane) ?? 0 : 0
        if (own <= 0 || heldBy(lane) >= own) return null
      }
      counter += 1
      const token = `seat-${counter}`
      seats.set(token, { taskId: null, attemptId: null, workerId: null, lane })
      return token
    },
    /**
     * Say WHO is in the seat, once the claim and then the route have answered.
     *
     * ИМЯ ПОПЫТКИ, А НЕ ТОЛЬКО ЗАДАЧИ. Задача — это строка, попытка — один её заход, и на одной
     * строке их может идти две (возврат в очередь, пока прежний проход ещё разматывает ворота).
     * Место принадлежит ЗАХОДУ; без его имени отдать место можно было только скопом по строке.
     *
     * И ЗДЕСЬ ЖЕ БЕРЁТСЯ ЗАНЯТОСТЬ РАБОТНИКА — в ту секунду, когда маршрут его назвал. Отдаётся
     * она отдельно (`release`), потому что живёт дольше: до конца ворот, а не до смерти ребёнка.
     */
    name(token, taskId, workerId = null, attemptId = null, lane = null) {
      const seat = seats.get(token)
      if (!seat) return
      if (typeof taskId === 'string' && taskId !== '') seat.taskId = taskId
      // …И ПОЛОСА ЗАХВАЧЕННОЙ РАБОТЫ. Место из общего пула берётся ДО захвата, когда полосы ещё
      // нет; названная здесь, она делает закрепление честным в обе стороны: полоса, уже ведущая
      // попытку с общего места, своё закреплённое не держит — гарантия «хотя бы одно» ей уже
      // выдана, а держать сверх неё значило бы отнимать места у остальных.
      if (typeof lane === 'string' && lane !== '' && !seat.lane) seat.lane = lane
      if (typeof attemptId === 'string' && attemptId !== '') seat.attemptId = attemptId
      if (typeof workerId === 'string' && workerId !== '') {
        seat.workerId = workerId
        busy.set(token, { taskId: seat.taskId, workerId })
      }
    },
    /** Отдать ВСЁ, что держал этот проход: и место под потолком, и занятость работника. */
    release(token) {
      if (typeof token !== 'string') return
      seats.delete(token)
      busy.delete(token)
    },
    /**
     * ОТДАТЬ МЕСТО ПО ИМЕНИ ПОПЫТКИ — дорога для того, кто жетона места не держит.
     *
     * Жетон знает только проход, который место взял; смерть же ребёнка подтверждает дверь
     * отмены, у которой жетона нет. Без этой дороги дверь могла бы честно ответить «попытка
     * закрылась» и не иметь ни одного способа сообщить об этом дому — что и произошло.
     *
     * ПОЧЕМУ ПО ЗАХОДУ, А НЕ ПО СТРОКЕ. Прежняя дорога снимала ВСЕ места этой задачи. На одной
     * строке живут два захода — прежний ещё идёт воротами, новый уже запущен, — и смерть одного
     * освобождала место второму, живому: потолок переставал считать настоящий процесс, и на
     * освободившееся место садилась третья работа. Имя захода различает их; строка — нет.
     *
     * Идемпотентно: отдать уже отданное место — не ошибка, а обычный порядок вещей, потому что
     * тот же `finally` прохода отдаст его вторым разом.
     */
    releaseAttempt(attemptId) {
      if (typeof attemptId !== 'string' || attemptId === '') return false
      for (const [token, seat] of seats) {
        if (seat && seat.attemptId === attemptId) {
          seats.delete(token)
          return true
        }
      }
      return false
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
 * И ЧЬЁ ИМЕННО МЕСТО ОТДАЁТСЯ — СПРАШИВАЕТСЯ ОТДЕЛЬНО. Имя строки не различает два её захода, а
 * место принадлежит заходу (см. `releaseAttempt`). Тик знает имя своего захода сам; дверь берёт
 * его у ручки, которую только что убила. Имени нет — место не отдаётся вовсе: снять чужое место
 * по совпадению строки дороже, чем подождать `finally` прохода, который отдаст своё в любом случае.
 *
 * @param {{attemptTurns?:object, inFlight?:object}} deps — те же зависимости, что у двери и у тика
 * @param {string} taskId
 * @param {string|null} attemptId — имя захода, чьё место освобождается
 * @returns {boolean}
 */
export function confirmProcessGone(deps, taskId, attemptId = null) {
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
  const named = typeof attemptId === 'string' && attemptId !== ''
  if (gone && named && deps.inFlight && typeof deps.inFlight.releaseAttempt === 'function') {
    deps.inFlight.releaseAttempt(attemptId)
  }
  return gone
}
