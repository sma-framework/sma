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
 */

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
 *   reserve:(cap:number)=>string|null,
 *   name:(token:string, taskId:string|null, workerId?:string|null)=>void,
 *   release:(token:string)=>void,
 * }}
 */
export function createInFlight() {
  const seats = new Map() // token → {taskId, workerId}
  let counter = 0
  return {
    size: () => seats.size,
    workers: () =>
      new Set([...seats.values()].map((s) => s && s.workerId).filter((id) => typeof id === 'string' && id !== '')),
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
  }
}
