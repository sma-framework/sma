/**
 * aging-memory.mjs — «сказать один раз», а не каждые пять секунд.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ФУНКЦИЯ В ЦИКЛЕ. У `loop.mjs` есть жёсткий закон и грепающий
 * его гейт: тик не строит НИ ОДНОЙ Map и НИ ОДНОГО Set — никакого реестра живых задач в
 * процессе, иначе перезапуск демона перестаёт быть бесплатным. Гейт этот файл и создал:
 * первая версия памяти была написана внутри цикла и была немедленно поймана. Закон говорит,
 * куда её девать: в отдельный модуль-помощник, который тик получает КОЛЛАБОРАТОРОМ, а не
 * заводит внутри себя.
 *
 * ПАМЯТЬ ЗДЕСЬ — НЕ СОСТОЯНИЕ ЗАДАЧ. В ней нет ни одной задачи как сущности: только «когда мы
 * в последний раз произносили про этот id вот эту фразу». Потеря этой памяти при перезапуске
 * стоит ровно одной лишней строки в журнале — то есть ничего.
 */

/** How long the aging signal stays silent about a task it has already spoken about. */
/** Один час в миллисекундах — местная константа: модуль ни от кого не зависит. */
const HOUR_MS = 3600000

export const AGING_REPEAT_MS = 24 * HOUR_MS

/**
 * createAgingMemory() → the small memory that turns «раз в пять секунд» into «раз на переход».
 *
 * WHY A COLLABORATOR IN `deps` AND NOT A FIELD OF THE TICK'S RESULT. The tick is stateless by
 * law, so the state has to live somewhere outside it — and the other way of doing that here,
 * threading it through the result (as intake's `lastScanAt` does), is joined by NOBODY in
 * production: the value comes out of the tick and no composition root puts it back. A
 * collaborator built ONCE beside `tickDeps` lives exactly as long as the daemon and cannot be
 * half-wired: either the object is in `deps` or the old behaviour stands.
 *
 * WHAT IT IS FOR. The measured live journal: 43 020 of 43 076 lines (99,87 %) were this one
 * signal, repeated every five seconds per stale task — 3,84 MB a day of one sentence. The
 * signal is worth saying when the threshold is CROSSED, and worth repeating once a day so a
 * task stuck for a week is not forgotten. Everything between those two moments is noise.
 *
 * IT CANNOT GROW FOREVER: every tick it is trimmed to the tasks that are still queued, so a
 * task that was taken, finished or dropped is forgotten — and a task that comes back and is
 * still old crosses the threshold anew, which is a real event and is said out loud.
 */
export function createAgingMemory() {
  /** taskId → when this signal was last said about it (epoch ms) */
  const saidAt = new Map()
  return {
    /** Say it now? Remembers the moment it was said, so the answer changes the memory. */
    shouldSay(taskId, now) {
      const prev = saidAt.get(taskId)
      if (Number.isFinite(prev) && now - prev < AGING_REPEAT_MS) return false
      saidAt.set(taskId, now)
      return true
    },
    /** Forget every task that is no longer waiting — the memory is as big as the queue. */
    keepOnly(ids) {
      const live = ids instanceof Set ? ids : new Set(ids)
      for (const id of [...saidAt.keys()]) if (!live.has(id)) saidAt.delete(id)
    },
    /** How many tasks are remembered right now (the growth of the Map is observable). */
    get size() {
      return saidAt.size
    },
  }
}
