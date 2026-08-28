/**
 * ПАДЕНИЕ ДЕМОНА: СКАЗАНО ЛИ ЧЕЛОВЕКУ, И КЕМ ИМЕННО.
 *
 * Окно раздаёт сам демон, и телеграм опрашивает тот же процесс, — значит одна смерть гасит оба
 * канала сразу, и человек узнаёт о ней по тому, что всё замолчало. Три обещания закрывают эту
 * дыру, и все три проверяются здесь, а не глазом на живой машине:
 *
 *   (а) окно, оставшееся открытым при упавшем демоне, говорит СЛОВАМИ, что связь потеряна и
 *       что бот молчит по той же причине;
 *   (б) сторож поднимает демона сам — по правилу, у которого есть таблица, а не по вере;
 *   (в) о падении и о подъёме приходит сообщение, и «поднялся» шлёт ТОТ, КТО ПОДНЯЛСЯ.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ ЭТОГО ФАЙЛА — ПОРЯДОК. Сообщение о подъёме обязано уйти ПОСЛЕ того, как
 * дверь ответила, а не до: сторож знает лишь про запуск подъёма, между запуском и живой дверью
 * стоит целый boot, и обещание в журнале ничего не стоит. Порядок проверяется общей лентой
 * событий — стук и отправка пишут в один список, — потому что два независимых счётчика могут
 * оба вырасти, ни разу не встретившись во времени.
 *
 * Ни одного живого процесса, сокета и телеграма: часы, стук, отправка, запуск подъёма и
 * файловый ввод-вывод здесь внедряются, а файловая часть работает во временном каталоге.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  announceRecovery,
  closeOutage,
  durationWords,
  fallWords,
  openOutage,
  outageMarkerPath,
  outageSeconds,
  readOutage,
  riseWords,
  stampOutage,
} from '../src/outage.mjs'
import { createWatch } from '../src/watch.mjs'
import { telegramApiBase, TELEGRAM_API_BASE } from '../src/telegram/client.mjs'
import { ApiError } from '../../spa/src/api/client'
import { doorSilent, linkLost, linkWords } from '../../spa/src/shell/link-state'

/** Свой каталог данных на каждый прогон: провал — это файл, и два прогона не делят один. */
function scratchConfig(overrides: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'sma-outage-'))
  return { dataDir, bind: '127.0.0.1', port: 7791, token: 'учебный', ...overrides }
}

/** Часы, которые двигает прогон: ни один разбор здесь не читает настоящее время. */
function clockFrom(startMs: number) {
  let at = startMs
  return {
    now: () => at,
    advance(ms: number) {
      at += ms
    },
  }
}

const T0 = Date.UTC(2026, 7, 28, 9, 0, 0)

// ── (в) СТОРОЖ: КОГДА ЭТО ПАДЕНИЕ, А КОГДА НЕТ ────────────────────────────────────

describe('сторож — молчание двери превращается в провал не сразу и не всегда', () => {
  /** Собрать сторожа над временным каталогом с полностью подставными швами. */
  function watchOver({
    answers,
    record = { pid: 4242, bind: '127.0.0.1', port: 7791, startedAt: '', path: '' },
    clock = clockFrom(T0),
    config = scratchConfig(),
  }: {
    answers: Array<{ answered: boolean; status?: number; reason?: string }>
    record?: unknown
    clock?: ReturnType<typeof clockFrom>
    config?: Record<string, unknown>
  }) {
    let knock = 0
    const sent: Array<{ text: string; at: number }> = []
    const lifts: Array<{ at: number }> = []
    const lines: string[] = []
    const watch = createWatch({
      config,
      probe: async () => {
        const a = answers[Math.min(knock, answers.length - 1)]
        knock += 1
        return { answered: a.answered, status: a.status ?? 0, state: null, reason: a.reason ?? '' }
      },
      readRecord: () => record,
      lift: { cmd: 'подъём', args: ['раз'], cwd: '.' },
      spawnLift: () => {
        lifts.push({ at: clock.now() })
      },
      notify: async ({ text }: { text: string }) => {
        sent.push({ text, at: clock.now() })
        return { sent: true, reason: '' }
      },
      now: clock.now,
      log: (l: string) => lines.push(l),
      missesToDeclare: 3,
      liftCooldownMs: 120000,
    })
    return { watch, sent, lifts, lines, config, clock }
  }

  it('дверь отвечает — это НЕ возвращение: сторожить нечего, и круг так и говорит', async () => {
    const w = watchOver({ answers: [{ answered: true, status: 200 }] })
    const round = await w.watch.tick()
    expect(round.phase).toBe('up')
    expect(w.lines).toHaveLength(0) // молчаливый круг не пишет ни строки
  })

  it('одно молчание — ещё не падение: ни слова человеку, ни попытки подъёма', async () => {
    const w = watchOver({ answers: [{ answered: false, reason: 'ECONNREFUSED' }] })
    const round = await w.watch.tick()
    expect(round.phase).toBe('suspect')
    expect(w.sent).toHaveLength(0)
    expect(w.lifts).toHaveLength(0)
  })

  it('три молчания подряд — провал: человеку сказано и подъём запущен, ровно по разу', async () => {
    const w = watchOver({ answers: [{ answered: false, reason: 'ECONNREFUSED' }] })
    expect((await w.watch.tick()).phase).toBe('suspect')
    w.clock.advance(15000)
    expect((await w.watch.tick()).phase).toBe('suspect')
    w.clock.advance(15000)
    expect((await w.watch.tick()).phase).toBe('declared')

    expect(w.sent).toHaveLength(1)
    expect(w.lifts).toHaveLength(1)

    // Четвёртый круг внутри выдержки не повторяет ни сообщения, ни подъёма.
    w.clock.advance(15000)
    expect((await w.watch.tick()).phase).toBe('down')
    expect(w.sent).toHaveLength(1)
    expect(w.lifts).toHaveLength(1)
  })

  it('час падения — это ПЕРВОЕ молчание, а не момент, когда сторож решился', async () => {
    const w = watchOver({ answers: [{ answered: false }] })
    await w.watch.tick() // первое молчание: T0
    w.clock.advance(15000)
    await w.watch.tick()
    w.clock.advance(15000)
    const round = await w.watch.tick() // объявление: T0 + 30 с

    expect(round.outage!.downAt).toBe(new Date(T0).toISOString())
    expect(round.outage!.declaredAt).toBe(new Date(T0 + 30000).toISOString())
  })

  it('после выдержки подъём повторяется, и каждая попытка ложится в запись', async () => {
    const w = watchOver({ answers: [{ answered: false }] })
    for (let i = 0; i < 3; i += 1) {
      await w.watch.tick()
      w.clock.advance(15000)
    }
    expect(w.lifts).toHaveLength(1)

    w.clock.advance(120000)
    const round = await w.watch.tick()
    expect(round.phase).toBe('lifting')
    expect(w.lifts).toHaveLength(2)
    expect(round.outage!.lifts).toHaveLength(2)
    expect(round.outage!.lifts[0].cmd).toBe('подъём раз')
  })

  it('штатно погашенного не воскрешает: записи о процессе нет — значит его убрала остановка', async () => {
    const w = watchOver({ answers: [{ answered: false }], record: null })
    for (let i = 0; i < 4; i += 1) {
      const round = await w.watch.tick()
      expect(round.phase).toBe('stopped')
      w.clock.advance(15000)
    }
    expect(w.sent).toHaveLength(0)
    expect(w.lifts).toHaveLength(0)
    expect(w.lines.join(' ')).toContain('Сам поднимать не буду')
  })

  it('сторож НЕ говорит «поднялся»: увидев живую дверь, он молчит — это слово не его', async () => {
    const w = watchOver({
      answers: [
        { answered: false },
        { answered: false },
        { answered: false },
        { answered: true, status: 200 },
      ],
    })
    for (let i = 0; i < 3; i += 1) {
      await w.watch.tick()
      w.clock.advance(15000)
    }
    expect(w.sent).toHaveLength(1)

    const back = await w.watch.tick()
    expect(back.phase).toBe('back')
    expect(w.sent).toHaveLength(1) // второго сообщения от сторожа нет и быть не может
    expect(w.sent[0].text).not.toContain('поднялся')
    expect(w.lines.join(' ')).toContain('я не он')
  })

  it('провал, начатый другим сторожем, продолжается, а не открывается заново', async () => {
    const config = scratchConfig()
    const first = watchOver({ answers: [{ answered: false }], config, clock: clockFrom(T0) })
    for (let i = 0; i < 3; i += 1) {
      await first.watch.tick()
      first.clock.advance(15000)
    }
    const opened = readOutage({ config })!

    // Второй сторож над тем же каталогом: перезапуск посреди провала.
    const second = watchOver({ answers: [{ answered: false }], config, clock: clockFrom(T0 + 600000) })
    for (let i = 0; i < 3; i += 1) {
      await second.watch.tick()
      second.clock.advance(15000)
    }
    expect(readOutage({ config })!.downAt).toBe(opened.downAt)
    expect(second.sent).toHaveLength(1) // о падении он сказал своё, но час падения — первый
  })

  it('телеграм отказал — провал всё равно открыт, отказ назван, подъём всё равно запущен', async () => {
    const config = scratchConfig()
    const clock = clockFrom(T0)
    const lifts: number[] = []
    const watch = createWatch({
      config,
      probe: async () => ({ answered: false, status: 0, state: null, reason: 'ECONNREFUSED' }),
      readRecord: () => ({ pid: 7, bind: '127.0.0.1', port: 7791, startedAt: '', path: '' }),
      lift: { cmd: 'подъём', args: [], cwd: '.' },
      spawnLift: () => lifts.push(clock.now()),
      notify: async () => ({ sent: false, reason: 'бот не подключён' }),
      now: clock.now,
      missesToDeclare: 1,
    })
    const round = await watch.tick()
    expect(round.phase).toBe('declared')
    expect(round.outage!.fallNotifiedAt).toBeNull()
    expect(round.outage!.fallNotice).toBe('бот не подключён')
    expect(lifts).toHaveLength(1)
  })
})

// ── (в) ПОДНЯВШИЙСЯ: КТО И КОГДА ГОВОРИТ «ПОДНЯЛСЯ» ──────────────────────────────

describe('поднявшийся демон — «поднялся» уходит после живой двери, а не до', () => {
  /** Одна лента на стук и на отправку: порядок доказуем только их общей историей. */
  function stage({ doorAnswersAfter }: { doorAnswersAfter: number }) {
    const config = scratchConfig()
    const clock = clockFrom(T0)
    const tape: Array<{ what: string; at: number }> = []
    let knocks = 0
    const deps = {
      config,
      probe: async () => {
        knocks += 1
        const answered = knocks > doorAnswersAfter
        tape.push({ what: answered ? 'дверь ответила' : 'дверь молчит', at: clock.now() })
        return { answered, status: answered ? 200 : 0, state: null, reason: answered ? '' : 'ECONNREFUSED' }
      },
      send: async ({ text }: { text: string }) => {
        tape.push({ what: `сообщение: ${text.slice(0, 24)}`, at: clock.now() })
        return { sent: true, reason: '' }
      },
      sleep: async (ms: number) => {
        clock.advance(ms)
      },
      now: clock.now,
      doorWaitMs: 60000,
      pollMs: 1000,
    }
    return { config, clock, tape, deps }
  }

  it('провала не было — обычный запуск не событие: ни сообщения, ни квитанции', async () => {
    const s = stage({ doorAnswersAfter: 0 })
    const res = await announceRecovery(s.deps)
    expect(res.announced).toBe(false)
    expect(res.reason).toBe('провала не было')
    expect(s.tape).toHaveLength(0) // даже стучаться было незачем
  })

  it('дверь ответила не сразу: сообщение стоит в ленте ПОСЛЕ ответа двери', async () => {
    const s = stage({ doorAnswersAfter: 3 })
    openOutage({ config: s.config, downAt: T0 - 300000, reason: 'ECONNREFUSED', now: () => T0 })

    const res = await announceRecovery(s.deps)
    expect(res.announced).toBe(true)

    const said = s.tape.findIndex((e) => e.what.startsWith('сообщение'))
    const opened = s.tape.findIndex((e) => e.what === 'дверь ответила')
    expect(opened).toBeGreaterThanOrEqual(0)
    expect(said).toBeGreaterThan(opened)
    // и по часам тоже, а не только по месту в списке
    expect(s.tape[said].at).toBeGreaterThanOrEqual(s.tape[opened].at)
    // до ответа двери в ленте одни стуки — ни одного слова человеку
    expect(s.tape.slice(0, opened).every((e) => e.what === 'дверь молчит')).toBe(true)
  })

  it('дверь так и не ответила — не сказано НИЧЕГО и провал остался открытым', async () => {
    const s = stage({ doorAnswersAfter: Number.MAX_SAFE_INTEGER })
    openOutage({ config: s.config, downAt: T0 - 60000, now: () => T0 })

    const res = await announceRecovery(s.deps)
    expect(res.announced).toBe(false)
    expect(res.reason).toBe('дверь не ответила')
    expect(s.tape.some((e) => e.what.startsWith('сообщение'))).toBe(false)
    expect(readOutage({ config: s.config })).not.toBeNull()
    expect(existsSync(outageMarkerPath(s.config))).toBe(true)
  })

  it('квитанция несёт все времена и закрывает провал: маркера больше нет', async () => {
    const s = stage({ doorAnswersAfter: 2 })
    const marker = openOutage({ config: s.config, downAt: T0 - 240000, reason: 'ECONNREFUSED', now: () => T0 })
    stampOutage({
      config: s.config,
      marker,
      patch: { fallNotifiedAt: new Date(T0).toISOString(), lifts: [{ at: new Date(T0).toISOString(), cmd: 'подъём', ok: true }] },
    })

    const res = await announceRecovery(s.deps)
    const receipt = JSON.parse(readFileSync(res.receiptPath, 'utf8'))

    expect(receipt.downAt).toBe(new Date(T0 - 240000).toISOString())
    expect(receipt.fallNotifiedAt).toBe(new Date(T0).toISOString())
    expect(receipt.lifts).toHaveLength(1)
    expect(Date.parse(receipt.doorBackAt)).toBeGreaterThanOrEqual(Date.parse(receipt.roseAt))
    expect(Date.parse(receipt.riseNotifiedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.doorBackAt))
    expect(receipt.downSeconds).toBe(240 + 2)
    expect(readOutage({ config: s.config })).toBeNull()
  })

  it('телеграм отказал на подъёме — провал всё равно закрыт, и отказ записан, а не забыт', async () => {
    const s = stage({ doorAnswersAfter: 0 })
    openOutage({ config: s.config, downAt: T0 - 30000, now: () => T0 })
    const res = await announceRecovery({ ...s.deps, send: async () => ({ sent: false, reason: 'чат не спарен' }) })

    expect(res.announced).toBe(false)
    const receipt = JSON.parse(readFileSync(res.receiptPath, 'utf8'))
    expect(receipt.riseNotifiedAt).toBeNull()
    expect(receipt.riseNotice).toBe('чат не спарен')
    expect(readOutage({ config: s.config })).toBeNull()
  })

  it('порванный маркер — это отсутствие провала, а не смерть на загрузке', async () => {
    const config = scratchConfig()
    mkdirSync(config.dataDir as string, { recursive: true })
    writeFileSync(outageMarkerPath(config), '{ это не json')
    expect(readOutage({ config })).toBeNull()
    const res = await announceRecovery({ config, probe: async () => ({ answered: true }), send: async () => ({ sent: true, reason: '' }) })
    expect(res.announced).toBe(false)
    expect(res.reason).toBe('провала не было')
  })
})

// ── СЛОВА, КОТОРЫЕ УЕЗЖАЮТ ЧЕЛОВЕКУ ──────────────────────────────────────────────

describe('слова о падении и о подъёме', () => {
  const marker = {
    downAt: new Date(T0).toISOString(),
    declaredAt: new Date(T0 + 45000).toISOString(),
    reason: 'ECONNREFUSED',
    door: 'http://127.0.0.1:7777',
    fallNotifiedAt: null,
    fallNotice: '',
    lifts: [],
  }

  it('о падении сказано главное: бот молчит по той же причине, и это не «нечего сказать»', () => {
    const words = fallWords(marker)
    expect(words).toContain('не отвечает')
    expect(words).toContain('нечего сказать')
    expect(words).toContain('http://127.0.0.1:7777')
    // и ни одного обещания о подъёме от того, кто его только запустил
    expect(words).not.toContain('поднялся')
  })

  it('о подъёме сказано в прошедшем времени и с длительностью провала', () => {
    const words = riseWords({ marker, doorBackAt: new Date(T0 + 254000).toISOString() })
    expect(words).toContain('поднялся')
    expect(words).toContain('4 мин 14 с')
  })

  it('длительность произносится словами, а непарсимое время не превращается в ноль', () => {
    expect(durationWords(41)).toBe('41 с')
    expect(durationWords(120)).toBe('2 мин')
    expect(durationWords(null)).toBe('неизвестно сколько')
    expect(outageSeconds({ downAt: 'мусор', doorBackAt: 'мусор' })).toBeNull()
  })

  it('квитанция ложится в свой каталог и называет себя часом падения', () => {
    const config = scratchConfig()
    const opened = openOutage({ config, downAt: T0, now: () => T0 })
    const { path } = closeOutage({
      config,
      marker: opened,
      doorBackAt: new Date(T0 + 60000).toISOString(),
      roseAt: new Date(T0 + 50000).toISOString(),
      now: () => T0 + 60000,
    })
    expect(path).toContain('outages')
    expect(path).toContain('outage-2026-08-28T09-00-00-000Z')
    expect(JSON.parse(readFileSync(path, 'utf8')).downSeconds).toBe(60)
  })
})

// ── АДРЕС BOT API: ШОВ, КОТОРЫМ ЖИВОЙ ПРОГОН НЕ ТРОГАЕТ ЧАТ ВЛАДЕЛЬЦА ────────────

describe('telegramApiBase — мнение конфига, иначе настоящий Bot API', () => {
  it('без мнения — настоящий адрес', () => {
    expect(telegramApiBase({})).toBe(TELEGRAM_API_BASE)
    expect(telegramApiBase({ telegram: { botToken: 'x' } })).toBe(TELEGRAM_API_BASE)
    expect(telegramApiBase({ telegram: { apiBase: '  ' } })).toBe(TELEGRAM_API_BASE)
  })

  it('объявленный адрес берётся, и хвостовая косая черта не удваивается', () => {
    expect(telegramApiBase({ telegram: { apiBase: 'http://127.0.0.1:7801/' } })).toBe('http://127.0.0.1:7801')
  })
})

// ── КТО СТОРОЖИТ СТОРОЖА ─────────────────────────────────────────────────────────

describe('единицы запуска сторожа — поставляются выключенными и целят в него', () => {
  const unit = (name: string) => readFileSync(new URL(`../../supervisor/${name}`, import.meta.url), 'utf8')

  it('виндовая задача сторожа выключена и запускает daemon-watch.mjs', () => {
    const xml = unit('sma-daemon-watch-windows.task.xml')
    expect(xml).toContain('<Enabled>false</Enabled>')
    expect(xml).toContain('daemon-watch.mjs')
    // Задержка больше, чем у собственной задачи демона (PT30S): сторож, пришедший раньше
    // конца загрузки, объявил бы падением обычную медленную машину.
    expect(xml).toContain('<Delay>PT2M</Delay>')
    expect(xml).toContain('<RestartOnFailure>')
  })

  it('объявление кодировки — UTF-16, как у обеих соседних задач, иначе импорт откажет', () => {
    expect(unit('sma-daemon-watch-windows.task.xml').startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true)
  })

  it('маковский близнец держит сторожа живым и целит туда же', () => {
    const plist = unit('com.sma.daemon-watch.plist')
    expect(plist).toContain('supervisor/daemon-watch.mjs')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('com.sma.daemon-watch')
  })

  it('ни одна виндовая задача этой папки не приезжает включённой', () => {
    for (const name of [
      'sma-daemon-windows.task.xml',
      'sma-daemon-logon-windows.task.xml',
      'sma-daemon-watch-windows.task.xml',
    ]) {
      expect(unit(name)).toContain('<Enabled>false</Enabled>')
    }
  })
})

// ── (а) ОКНО ГОВОРИТ СЛОВАМИ ─────────────────────────────────────────────────────

describe('окно при упавшем демоне — говорит, а не выглядит рабочим', () => {
  it('ответ со статусом — это не потеря связи: демон жив и имеет мнение', () => {
    expect(doorSilent(new ApiError(404, 'нет такой двери'))).toBe(false)
    expect(doorSilent(new ApiError(401, 'кто вы'))).toBe(false)
    expect(doorSilent(new ApiError(500, 'внутри плохо'))).toBe(false)
  })

  it('оборванный сокет и истёкшее ожидание — это тишина', () => {
    expect(doorSilent(new TypeError('Failed to fetch'))).toBe(true)
    expect(doorSilent(new Error('окно не дождалось ответа за 30 с'))).toBe(true)
  })

  it('пока чтение не исчерпало повторы, полоса молчит — подозрение никого не пугает', () => {
    expect(linkLost({ isError: false, error: new TypeError('Failed to fetch'), dataUpdatedAt: T0 })).toBe(false)
    expect(linkLost({ isError: true, error: new ApiError(404, ''), dataUpdatedAt: T0 })).toBe(false)
    expect(linkLost({ isError: true, error: new TypeError('Failed to fetch'), dataUpdatedAt: T0 })).toBe(true)
  })

  it('сказаны обе половины: связь потеряна И бот молчит по той же причине', () => {
    const words = linkWords({ isError: true, error: new TypeError('нет'), dataUpdatedAt: T0 })
    const all = words.join(' ')
    expect(all).toContain('Связь с демоном потеряна')
    expect(all).toContain('телеграме сейчас тоже тишина')
    expect(all).toContain('daemon:watch')
    expect(all).toContain('daemon:restart')
  })

  it('названо, насколько давнее то, что на экране, — и отдельно случай «ни разу»', () => {
    const seen = linkWords({ isError: true, error: new TypeError('нет'), dataUpdatedAt: T0 }).join(' ')
    expect(seen).toContain('последнее, что окно успело прочитать')
    const never = linkWords({ isError: true, error: new TypeError('нет'), dataUpdatedAt: 0 }).join(' ')
    expect(never).toContain('ни разу')
  })
})
