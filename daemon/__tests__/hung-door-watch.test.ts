/**
 * ЖИВОЙ ПРОЦЕСС С МЁРТВОЙ ДВЕРЬЮ — И СТОРОЖ, КОТОРЫЙ НАКОНЕЦ ЭТО ЛОВИТ.
 *
 * ═════════════ ЧТО БЫЛО ЗАМЕРЕНО ════════════════════════════════════════════════
 * 29.08 вечером: процесс жив (56 МБ, CPU идёт), а `GET /` висит до таймаута 8 с три пробы
 * подряд; в журнале тем же временем — шторм «telegram getUpdates: This operation was aborted»
 * строка за строкой. Клин держался ~10 минут ПРИ РАБОТАЮЩЕМ стороже, и сторож не перезапустил
 * ничего. Обе штатные остановки того дня сказали одно и то же: «дверь молчит, а процесс жив».
 *
 * 31.08 ночью, три пробы подряд по живой двери: одна НЕ уложилась в 6 секунд, две ответили за
 * 2.7 с и 0.007 с. То есть под нагрузкой живая дверь регулярно отвечает дольше короткого
 * терпения, и сторож с порогом в единицы секунд объявит здорового демона покойником.
 * Второй замер той же ночи: после подъёма дверь честно молчит ~45 с на стартовой уборке копий
 * (29.08 наблюдалось до ~2 минут) — и это НЕ смерть.
 *
 * ═════════════ ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ ═══════════════════════════════════════════
 *   (а) терпение ОДНОГО стука кратно больше замеренной задержки под нагрузкой, а приговор
 *       стоит на СЕРИИ стуков, а не на одном;
 *   (б) «жив, но дверь молчит N проб» = смерть: сторож ГАСИТ процесс и только потом поднимает
 *       (подъём над живым процессом проигрывает гонку за порт — ровно это и было 29.08);
 *   (в) живая-но-медленная дверь перезапуска НЕ получает, и стартовая уборка тоже;
 *   (г) телеграм-опрос несёт жёсткий таймаут на ВЕСЬ вызов (включая чтение тела) и на круг,
 *       а шторм одинаковых отказов схлопывается в несколько строк с растущей паузой.
 *
 * Ни одного живого процесса, сокета и телеграма: часы, стук, сигнал, живость процесса, запуск
 * подъёма, сон и отправка — внедряются.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWatch,
  KNOCK_TIMEOUT_MS,
  MEASURED_DOOR_LATENCY_MS,
  STARTUP_GRACE_MS,
  TIMEOUT_MISSES_TO_DECLARE,
} from '../src/watch.mjs'
import { closeOutage, readOutage } from '../src/outage.mjs'
import { createTelegramClient } from '../src/telegram/client.mjs'
import { createTelegramBridge, POLL_BACKOFF_MAX_MS, POLL_BACKOFF_MS } from '../src/telegram/poll.mjs'

const T0 = Date.UTC(2026, 7, 31, 2, 0, 0)
const POLL_MS = 15000

function scratchConfig(overrides: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'sma-hung-'))
  return { dataDir, bind: '127.0.0.1', port: 7791, token: 'учебный', ...overrides }
}

/** Одна лента событий на прогон: порядок «сначала погасил, потом поднял» иначе не доказать. */
type Event = { what: 'knock' | 'signal' | 'lift' | 'notify'; at: number; detail?: string }

/**
 * Сторож над подставным миром: дверь, запись о процессе, его живость и сигналы — всё внедрено.
 *
 * `doorLatencyMs` — сколько «занимает» один стук по часам прогона: живая-но-медленная дверь
 * отличается от повешенной именно тем, что она ОТВЕЧАЕТ, просто не сразу.
 */
function watchWorld({
  door,
  alivePid = 4242,
  recordPid,
  startedAt = new Date(T0 - 3600_000).toISOString(),
  doorLatencyMs = 0,
  killedByTerm = true,
  config = scratchConfig(),
}: {
  door: (round: number) => { answered: boolean; status?: number; kind?: string; reason?: string }
  alivePid?: number | null
  /** Номер В ЗАПИСИ, если он отличается от живого: запись мёртвого процесса — законный случай. */
  recordPid?: number | null
  startedAt?: string
  doorLatencyMs?: number
  killedByTerm?: boolean
  config?: Record<string, unknown>
}) {
  let at = T0
  let round = 0
  let livePid: number | null = alivePid
  const onRecord = recordPid ?? alivePid
  let record: null | { pid: number; bind: string; port: number; startedAt: string; path: string } =
    onRecord === null ? null : { pid: onRecord, bind: '127.0.0.1', port: 7791, startedAt, path: '' }
  const events: Event[] = []
  const lines: string[] = []
  const now = () => at
  const advance = (ms: number) => {
    at += ms
  }

  const watch = createWatch({
    config,
    probe: async () => {
      const answer = door(round)
      round += 1
      at += doorLatencyMs
      events.push({ what: 'knock', at })
      return {
        answered: answer.answered,
        status: answer.status ?? 0,
        state: null,
        reason: answer.reason ?? '',
        kind: answer.kind ?? (answer.answered ? '' : 'timeout'),
      }
    },
    readRecord: () => record,
    isAlive: (pid: number) => livePid === pid,
    signalProcess: (pid: number, sig: string) => {
      events.push({ what: 'signal', at, detail: `${sig}:${pid}` })
      if (sig === 'SIGTERM' && killedByTerm) livePid = null
      if (sig === 'SIGKILL') livePid = null
    },
    clearRecord: () => {
      record = null
      return true
    },
    lift: { cmd: 'подъём', args: ['раз'], cwd: '.' },
    spawnLift: () => {
      events.push({ what: 'lift', at })
      return { log: '' }
    },
    notify: async ({ text }: { text: string }) => {
      events.push({ what: 'notify', at, detail: text })
      return { sent: true, reason: '' }
    },
    now,
    sleep: async (ms: number) => {
      at += ms // ожидание смерти процесса идёт по часам прогона, а не по настоящим
    },
    log: (l: string) => lines.push(l),
  })

  return {
    watch,
    events,
    lines,
    config,
    advance,
    now,
    signals: () => events.filter((e) => e.what === 'signal'),
    lifts: () => events.filter((e) => e.what === 'lift'),
    notifies: () => events.filter((e) => e.what === 'notify'),
  }
}

/** Прокрутить N кругов сторожа с обычной паузой между ними. */
async function rounds(world: ReturnType<typeof watchWorld>, count: number) {
  const phases: string[] = []
  for (let i = 0; i < count; i += 1) {
    phases.push((await world.watch.tick()).phase)
    world.advance(POLL_MS)
  }
  return phases
}

// ── (а) ТЕРПЕНИЕ ОДНОГО СТУКА ПРОТИВ ЗАМЕРЕННОЙ ЗАДЕРЖКИ ─────────────────────────

describe('порог сторожа против замера 31.08', () => {
  it('терпение одного стука кратно больше задержки, замеренной под нагрузкой', () => {
    // Замер живёт В КОДЕ, а не в чьей-то памяти: порог, «взятый с потолка», однажды окажется
    // ниже того, что дверь честно показывала, и сторож начнёт убивать здоровых.
    expect(MEASURED_DOOR_LATENCY_MS).toBeGreaterThanOrEqual(6000)
    expect(KNOCK_TIMEOUT_MS / MEASURED_DOOR_LATENCY_MS).toBeGreaterThanOrEqual(4)
  })

  it('приговор стоит на СЕРИИ проб, а не на одной: одного истёкшего ожидания мало', async () => {
    const world = watchWorld({ door: () => ({ answered: false, kind: 'timeout' }) })
    const phases = await rounds(world, 1)
    expect(phases).toEqual(['suspect'])
    expect(world.signals()).toHaveLength(0)
    expect(world.lifts()).toHaveLength(0)
    expect(TIMEOUT_MISSES_TO_DECLARE).toBeGreaterThanOrEqual(3)
  })
})

// ── (б) КРАСНЫЙ ТЕСТ: ЗАМОРОЖЕННАЯ ДВЕРЬ → ГАСИТЬ И ПОДНЯТЬ ──────────────────────

describe('замороженный обработчик двери — это смерть, и сторож её лечит', () => {
  it('серия неответов при живом процессе: сторож ГАСИТ процесс и только потом поднимает', async () => {
    const world = watchWorld({ door: () => ({ answered: false, kind: 'timeout' }) })
    await rounds(world, TIMEOUT_MISSES_TO_DECLARE)

    const signals = world.signals()
    const lifts = world.lifts()
    expect(signals.length).toBeGreaterThanOrEqual(1)
    expect(signals[0].detail).toBe('SIGTERM:4242')
    expect(lifts).toHaveLength(1)
    // ПОРЯДОК И ЕСТЬ ПРЕДМЕТ: подъём над живым процессом проигрывает гонку за порт, и ровно
    // поэтому 29.08 три попытки подряд ничего не подняли.
    expect(world.events.indexOf(signals[0])).toBeLessThan(world.events.indexOf(lifts[0]))
    expect(world.notifies()).toHaveLength(1)
    expect(world.lines.join(' ')).toContain('гашу')
  })

  it('квитанция называет убитого: провал, закрытый после гашения, помнит чей это был процесс', async () => {
    const config = scratchConfig()
    const world = watchWorld({ door: () => ({ answered: false, kind: 'timeout' }), config })
    await rounds(world, TIMEOUT_MISSES_TO_DECLARE)

    const marker = readOutage({ config })
    expect(marker?.kills?.[0]?.pid).toBe(4242)

    const { receipt } = closeOutage({ config, marker, doorBackAt: world.now(), roseAt: world.now(), now: world.now })
    // Квитанция со списком полей молчаливо теряет всё, чего в нём нет: «я убил процесс, который
    // держал дверь» — ровно тот факт, которым потом объясняют потерянную попытку.
    expect(receipt.kills).toHaveLength(1)
    expect(receipt.kills[0].pid).toBe(4242)
  })

  it('процесс, переживший SIGTERM, добивается SIGKILL — и только потом подъём', async () => {
    const world = watchWorld({ door: () => ({ answered: false, kind: 'timeout' }), killedByTerm: false })
    await rounds(world, TIMEOUT_MISSES_TO_DECLARE)

    const sigs = world.signals().map((s) => s.detail)
    expect(sigs).toContain('SIGTERM:4242')
    expect(sigs).toContain('SIGKILL:4242')
    expect(world.lifts()).toHaveLength(1)
  })

  it('гасить некого — вслепую не сигналим: запись мёртвого процесса просто поднимается', async () => {
    // `alivePid: null` — запись на диске есть, а процесса за ней уже нет. Сигнал по такому
    // номеру попал бы в чужой процесс, переиспользовавший его: это цена промаха, и её здесь
    // не платят.
    const world = watchWorld({
      door: () => ({ answered: false, kind: 'refused', reason: 'ECONNREFUSED' }),
      alivePid: null,
      recordPid: 4242,
    })
    await rounds(world, 3)
    expect(world.signals()).toHaveLength(0)
    expect(world.lifts()).toHaveLength(1)
  })
})

// ── (в) ЖИВАЯ-НО-МЕДЛЕННАЯ ДВЕРЬ И СТАРТОВАЯ УБОРКА — НЕ СМЕРТЬ ──────────────────

describe('живого не гасим', () => {
  it('дверь, отвечающая с замеренной задержкой под нагрузкой, перезапуска НЕ получает', async () => {
    const world = watchWorld({
      door: () => ({ answered: true, status: 200 }),
      doorLatencyMs: MEASURED_DOOR_LATENCY_MS,
    })
    const phases = await rounds(world, 20)
    expect(new Set(phases)).toEqual(new Set(['up']))
    expect(world.signals()).toHaveLength(0)
    expect(world.lifts()).toHaveLength(0)
    expect(world.notifies()).toHaveLength(0)
  })

  it('серия истёкших ожиданий, оборванная ответом, приговором не становится', async () => {
    const world = watchWorld({
      door: (round) => (round < TIMEOUT_MISSES_TO_DECLARE - 1 ? { answered: false, kind: 'timeout' } : { answered: true, status: 200 }),
    })
    await rounds(world, TIMEOUT_MISSES_TO_DECLARE + 4)
    expect(world.signals()).toHaveLength(0)
    expect(world.lifts()).toHaveLength(0)
    expect(world.notifies()).toHaveLength(0)
  })

  it('стартовая уборка: молодой процесс молчит — это «грузится», а не «заклинило»', async () => {
    const world = watchWorld({
      door: () => ({ answered: false, kind: 'timeout' }),
      startedAt: new Date(T0 - 30_000).toISOString(), // поднялся 30 секунд назад
    })
    const phases = await rounds(world, TIMEOUT_MISSES_TO_DECLARE + 2)
    expect(new Set(phases)).toEqual(new Set(['starting']))
    expect(world.signals()).toHaveLength(0)
    expect(world.lifts()).toHaveLength(0)
    expect(world.notifies()).toHaveLength(0)
    expect(world.lines.join(' ')).toMatch(/уборк|грузится|подним/i)
  })

  it('но выдержка кончается: тот же молчащий процесс после неё объявляется мёртвым', async () => {
    const world = watchWorld({
      door: () => ({ answered: false, kind: 'timeout' }),
      startedAt: new Date(T0 - 30_000).toISOString(),
    })
    await rounds(world, 2)
    world.advance(STARTUP_GRACE_MS)
    await rounds(world, TIMEOUT_MISSES_TO_DECLARE)
    expect(world.signals().length).toBeGreaterThanOrEqual(1)
    expect(world.lifts()).toHaveLength(1)
  })
})

// ── (г) ТЕЛЕГРАМ-ОПРОС: ЖЁСТКИЙ ТАЙМАУТ И НЕВОСПРОИЗВОДИМЫЙ ШТОРМ ────────────────

const BOT_TOKEN = '1234567890:ААААААААААААААААААААААААААААААААААА'

describe('телеграм-опрос не душит цикл', () => {
  it('жёсткий таймаут накрывает ВЕСЬ вызов, включая чтение тела ответа', async () => {
    // Тело, которое не приходит после заголовков, — это ровно то молчание, которое ничем не
    // ограничено: срок снимался сразу после fetch, и чтение тела висело без потолка.
    const client = createTelegramClient({
      config: { telegram: { botToken: BOT_TOKEN } },
      callTimeoutMs: 30,
      fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as never,
    })
    await expect(client.getUpdates({ timeout: 0 })).rejects.toThrow(/не дождался/i)
  })

  it('круг, который не отвечает вовсе, не заклинивает цикл — он обрывается и повторяется', async () => {
    let asked = 0
    let aborted = 0
    const bridge = createTelegramBridge({
      config: { telegram: { botToken: BOT_TOKEN, chatId: '77' } },
      client: {
        getUpdates: ({ signal }: { signal?: AbortSignal }) =>
          new Promise<never>((_, reject) => {
            asked += 1
            if (signal) signal.addEventListener('abort', () => {
              aborted += 1
              reject(new Error('This operation was aborted'))
            })
          }),
        sendMessage: async () => ({}),
        sendChatAction: async () => ({}),
      },
      roundTimeoutMs: 5,
      sleep: async () => {},
      log: () => {},
    })!
    bridge.start()
    const until = Date.now() + 4000
    while (asked < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
    bridge.stop()
    expect(asked).toBeGreaterThanOrEqual(3) // цикл жив: круг оборвали и пошли дальше
    expect(aborted).toBeGreaterThanOrEqual(1) // и оборвали его ЯВНО, а не бросили висеть
  })

  it('шторм одинаковых отказов схлопывается в несколько строк, а пауза растёт до потолка', async () => {
    const lines: string[] = []
    const sleeps: number[] = []
    let asked = 0
    let bridge: { stop: () => unknown } | null = null
    const made = createTelegramBridge({
      config: { telegram: { botToken: BOT_TOKEN, chatId: '77' } },
      client: {
        getUpdates: async () => {
          asked += 1
          throw new Error('telegram getUpdates: This operation was aborted')
        },
        sendMessage: async () => ({}),
        sendChatAction: async () => ({}),
      },
      sleep: async (ms: number) => {
        sleeps.push(ms)
        if (asked >= 64 && bridge) bridge.stop()
      },
      log: (l: string) => lines.push(l),
    })!
    bridge = made
    await made.start()

    expect(asked).toBeGreaterThanOrEqual(64)
    // 64 одинаковых отказа — это НЕ 64 строки: иначе журнал становится стеной, в которой
    // ничего больше не видно (ровно так выглядел лог 29.08).
    expect(lines.filter((l) => l.includes('aborted')).length).toBeLessThanOrEqual(10)
    expect(sleeps[0]).toBe(POLL_BACKOFF_MS)
    expect(Math.max(...sleeps)).toBe(POLL_BACKOFF_MAX_MS)
    expect(sleeps.every((ms) => ms <= POLL_BACKOFF_MAX_MS)).toBe(true)
  })
})
