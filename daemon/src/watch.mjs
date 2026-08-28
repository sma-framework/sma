/**
 * watch.mjs — СТОРОЖ ДЕМОНА: тот, кто остаётся жив, когда всё остальное замолчало.
 *
 * ═════════════ ЗАЧЕМ ОН НУЖЕН ════════════════════════════════════════════════════
 * Окно — веб-морда демона, и телеграм опрашивает тот же процесс. Один упавший процесс уносит
 * оба канала сразу, и дверь назад остаётся ровно одна — командная строка. Пока терминал
 * открыт, это терпимо; для человека, который живёт в окне и в телефоне, это единственная
 * точка отказа всей системы, и узнаёт он о ней по тому, что всё молчит.
 *
 * Сторож — маленький процесс, который умеет только три вещи: стучать в дверь, сказать
 * человеку, что она замолчала, и поднять демона тем же подъёмом, что и супервизор. Он
 * НИЧЕГО не знает про очередь, про задачи и про модель; у него нет ни базы, ни своей двери.
 * Это сделано ради одного свойства: чем меньше он умеет, тем меньше поводов умереть у того,
 * кто сторожит остальных.
 *
 * ═════════════ ОДНО МОЛЧАНИЕ — ЕЩЁ НЕ ПАДЕНИЕ ════════════════════════════════════
 * Провал объявляется только после нескольких подряд неотвеченных стуков. Одна потерянная
 * посылка, одна секунда сборки мусора, один занятый цикл — это не смерть, а сообщение
 * «демон упал», отправленное на такую рябь, обесценивает все следующие. Час падения при
 * этом записывается по ПЕРВОМУ молчанию, а не по моменту решения (см. outage.mjs).
 *
 * ═════════════ ЧЕГО ОН НЕ ДЕЛАЕТ: НЕ ВОСКРЕШАЕТ ПОГАШЕННОЕ ══════════════════════
 * Штатная остановка (`npm run daemon:stop`) убирает запись о процессе — это её последний шаг.
 * Аварийная смерть запись ОСТАВЛЯЕТ: умерший процесс не успевает ничего убрать. Эта разница
 * уже существовала в продукте, и сторож читает именно её:
 *
 *     дверь молчит + запись на месте  → это падение     → сказать и поднять
 *     дверь молчит + записи нет       → это остановка   → сказать один раз в журнал и не лезть
 *
 * Сторож, который поднимает демона, только что осознанно погашенного человеком, — это не
 * страховка, а противник, с которым приходится драться. Поэтому такого поведения здесь нет.
 *
 * ═════════════ «ПОДНЯЛСЯ» ГОВОРИТ НЕ ОН ══════════════════════════════════════════
 * Сторож знает лишь то, что он ЗАПУСТИЛ подъём. Между запуском и живой дверью стоит целый
 * boot, который умеет падать. Поэтому о падении говорит сторож (больше некому — тот, кто мог
 * бы, и есть покойник), а о подъёме говорит сам поднявшийся демон, уже после того, как его
 * собственная дверь ответила на настоящий запрос (daemon/src/outage.mjs). Здесь эта половина
 * не реализуется и не имитируется: увидев живую дверь, сторож просто закрывает свою часть
 * работы и молчит.
 *
 * Каждый шов — стук, часы, сон, запуск подъёма, отправка, файловый ввод-вывод — внедряется,
 * поэтому вся таблица решений проверяется без процесса, без сокета и без телеграма.
 */

import { doorUrl, liftCommand, probeDoor, readPidRecord } from './control.mjs'
import { fallWords, notifyOwner, openOutage, stampOutage } from './outage.mjs'

/** Как часто спрашивают дверь. Пятнадцать секунд — минута на объявление провала. */
export const POLL_MS = 15000

/** Сколько подряд неотвеченных стуков превращают молчание в провал. */
export const MISSES_TO_DECLARE = 3

/** Реже этого подъём не повторяется: boot демона занимает десятки секунд. */
export const LIFT_COOLDOWN_MS = 120000

/**
 * Каждое состояние, в котором может закончиться один круг сторожа, замкнутым списком.
 *
 *   up          дверь отвечает — сторожить нечего
 *   back        дверь ответила после провала; о подъёме скажет сам поднявшийся
 *   suspect     молчит, но ещё не столько раз, чтобы это называть падением
 *   declared    провал объявлен: человеку сказано, подъём запущен
 *   lifting     провал продолжается, подъём повторён после выдержки
 *   down        провал продолжается, до следующей попытки ещё рано
 *   stopped     двери нет и записи нет — демона погасили штатно, не лезем
 */
export const PHASES = Object.freeze(['up', 'back', 'suspect', 'declared', 'lifting', 'down', 'stopped'])

/**
 * createWatch(deps) → {tick, run, stop, state}.
 *
 * `tick()` — ОДИН круг: стук, решение, действие. Он и есть предмет проверки; `run()` только
 * повторяет его во сне, поэтому в тестах нет ни одного таймера.
 */
export function createWatch({
  config = {},
  probe = (cfg) => probeDoor({ config: cfg }),
  readRecord = (cfg) => readPidRecord({ config: cfg }),
  lift = liftCommand(),
  spawnLift,
  notify = (o) => notifyOwner(o),
  openOutageImpl = (o) => openOutage(o),
  stampOutageImpl = (o) => stampOutage(o),
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
  pollMs = POLL_MS,
  missesToDeclare = MISSES_TO_DECLARE,
  liftCooldownMs = LIFT_COOLDOWN_MS,
} = {}) {
  const where = doorUrl(config)
  let misses = 0
  let firstMissAt = 0
  let outage = null
  let lastLiftAt = 0
  let saidStopped = false
  let running = false

  /**
   * Подъём — тем же путём, что и супервизор (liftCommand), и его исход ложится В ЗАПИСЬ.
   * Список попыток на маркере — это то, что потом читает квитанция: «поднимал трижды» и
   * «поднимал однажды» — разные истории одного и того же провала.
   */
  function doLift() {
    const at = new Date(now()).toISOString()
    let ok = true
    let error = ''
    try {
      spawnLift(lift)
    } catch (err) {
      ok = false
      error = String((err && err.message) || err)
    }
    lastLiftAt = now()
    const attempt = { at, cmd: `${lift.cmd} ${lift.args.join(' ')}`, ok, ...(error ? { error } : {}) }
    outage = stampOutageImpl({ config, marker: outage, patch: { lifts: [...(outage.lifts ?? []), attempt] } })
    log(ok ? `подъём запущен: ${attempt.cmd}` : `подъём НЕ запустился: ${error}`)
    return ok
  }

  async function tick() {
    const door = await probe(config)

    if (door && door.answered) {
      // «Вернулась» и «стоит» — разные новости, и путать их нельзя: первая закрывает провал,
      // вторая не сообщает ни о чём. Один и тот же ответ двери, два разных исхода круга.
      const wasDown = outage !== null
      if (wasDown) {
        log(`дверь ${where} снова отвечает (${door.status}). О подъёме скажет сам поднявшийся демон — я не он.`)
        outage = null
      }
      misses = 0
      firstMissAt = 0
      saidStopped = false
      return { phase: wasDown ? 'back' : 'up', misses: 0, door, outage: null }
    }

    misses += 1
    if (misses === 1) firstMissAt = now()

    // Штатно погашенного не воскрешаем: запись о процессе убирает именно остановка.
    const record = readRecord(config)
    if (!record && !outage) {
      if (!saidStopped) {
        saidStopped = true
        log(`дверь ${where} молчит, записи о процессе нет — это штатная остановка или демон здесь не запускался. Сам поднимать не буду.`)
      }
      return { phase: 'stopped', misses, door, outage: null }
    }

    if (!outage) {
      if (misses < missesToDeclare) return { phase: 'suspect', misses, door, outage: null }

      outage = openOutageImpl({
        config,
        downAt: firstMissAt,
        reason: (door && door.reason) || 'нет ответа',
        now,
      })
      log(`провал: дверь ${where} молчит ${misses} стука подряд, с ${outage.downAt}. Говорю человеку и поднимаю.`)
      const said = await notify({ config, text: fallWords(outage) })
      outage = stampOutageImpl({
        config,
        marker: outage,
        patch: {
          fallNotifiedAt: said.sent ? new Date(now()).toISOString() : null,
          fallNotice: said.reason,
        },
      })
      if (!said.sent) log(`о падении сказать в телеграм не вышло: ${said.reason}`)
      doLift()
      return { phase: 'declared', misses, door, outage }
    }

    if (now() - lastLiftAt >= liftCooldownMs) {
      doLift()
      return { phase: 'lifting', misses, door, outage }
    }
    return { phase: 'down', misses, door, outage }
  }

  return {
    tick,
    /** Что сторож думает прямо сейчас — читается тестом и командой, не угадывается. */
    state: () => ({ misses, firstMissAt, outage, lastLiftAt, running }),
    /** run() — тот же круг во сне, пока не попросят остановиться. */
    async run() {
      running = true
      while (running) {
        try {
          await tick()
        } catch (err) {
          // Сторож, умерший на собственной ошибке, — это сторож, которого некому сторожить.
          log(`круг не отработал: ${String((err && err.stack) || err)}`)
        }
        if (!running) break
        await sleep(pollMs)
      }
    },
    stop() {
      running = false
    },
  }
}
