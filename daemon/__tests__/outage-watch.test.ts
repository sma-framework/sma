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
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  announceRecovery,
  closeOutage,
  durationWords,
  fallWords,
  openOutage,
  outageMarkerPath,
  outageReceiptsDir,
  outageSeconds,
  readOutage,
  riseWords,
  stampOutage,
} from '../src/outage.mjs'
import { createWatch, KNOCK_PATH, KNOCK_TIMEOUT_MS, LIFT_DOOR_WAIT_MS } from '../src/watch.mjs'
import { noteLift, openLiftLog, spawnLiftLogged, tailLiftLog } from '../../supervisor/lift-log.mjs'
import { probeDoor } from '../src/control.mjs'
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
    liftChangesPid = true,
  }: {
    answers: Array<{ answered: boolean; status?: number; reason?: string; kind?: string }>
    record?: unknown
    clock?: ReturnType<typeof clockFrom>
    config?: Record<string, unknown>
    // ПОДЪЁМ, КОТОРЫЙ СРАБОТАЛ, ОСТАВЛЯЕТ ДРУГОЙ ПРОЦЕСС — и подделка обязана это отражать,
    // иначе она умеет меньше жизни: сторож отличает настоящее воскрешение от ложной тревоги
    // именно по смене записи о процессе. `false` — подъём, который ничего не поднял, потому
    // что демон и не умирал: ровно то, что делает наш скрипт подъёма над живой дверью.
    liftChangesPid?: boolean
  }) {
    let knock = 0
    let live = record as { pid: number }
    const sent: Array<{ text: string; at: number }> = []
    const lifts: Array<{ at: number }> = []
    const lines: string[] = []
    const watch = createWatch({
      config,
      probe: async () => {
        const a = answers[Math.min(knock, answers.length - 1)]
        knock += 1
        return {
          answered: a.answered,
          status: a.status ?? 0,
          state: null,
          reason: a.reason ?? '',
          kind: a.kind ?? (a.answered ? '' : 'refused'),
        }
      },
      readRecord: () => live,
      // ЗДЕСЬ ПРОВЕРЯЕТСЯ МЁРТВЫЙ ДЕМОН: запись осталась от процесса, которого уже нет. Шов
      // назван ЯВНО, а не оставлен на умолчание, потому что умолчание спрашивает у настоящей
      // системы про настоящий номер 4242 — и однажды попало бы сигналом в чужую работу.
      isAlive: () => false,
      lift: { cmd: 'подъём', args: ['раз'], cwd: '.' },
      spawnLift: () => {
        lifts.push({ at: clock.now() })
        if (liftChangesPid) live = { ...live, pid: live.pid + 1 }
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

    // ВЫДЕРЖКА БОЛЬШЕ НЕ ГЛАВНАЯ ВЕЛИЧИНА: повтор невозможен раньше, чем назван исход прошлой
    // попытки, а исход называет дверь — за LIFT_DOOR_WAIT_MS, и с 31.08 этот срок покрывает
    // стартовую уборку копий (замер: ~45 с, наблюдалось до ~2 минут). Пока он идёт, круг честно
    // отвечает «down»: демон может быть в середине boot'а.
    w.clock.advance(LIFT_DOOR_WAIT_MS + 1000)
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

  // ── ЗАНЯТЫЙ ДЕМОН — НЕ ПОКОЙНИК ────────────────────────────────────────────────
  //
  // 28.08 сторож объявил падение живого демона и написал владельцу в телеграм. Демон был
  // занят шестью попытками, а сторож спрашивал у самой тяжёлой двери продукта с терпением в
  // три секунды. Ниже — то, чего не хватало, чтобы этого не случилось.

  it('истёкшее ожидание НЕ становится падением по трём кругам: занятый демон выглядит именно так', async () => {
    const w = watchOver({ answers: [{ answered: false, kind: 'timeout' }] })
    for (let i = 0; i < 6; i += 1) {
      const round = await w.watch.tick()
      expect(round.phase).toBe('suspect') // подозрение — да; приговор — нет
      w.clock.advance(15000)
    }
    expect(w.sent).toHaveLength(0) // владельца не будили
    expect(w.lifts).toHaveLength(0) // и поднимать живого не пытались
  })

  it('но и повешенного не выгораживает: молчание, которое всё длится, падением всё-таки станет', async () => {
    const w = watchOver({ answers: [{ answered: false, kind: 'timeout' }] })
    for (let i = 0; i < 12; i += 1) {
      await w.watch.tick()
      w.clock.advance(15000)
    }
    expect(w.sent).toHaveLength(1)
    expect(w.lifts).toHaveLength(1)
  })

  it('отказ в соединении остаётся доказательством смерти и хватает трёх', async () => {
    const w = watchOver({ answers: [{ answered: false, kind: 'refused', reason: 'ECONNREFUSED' }] })
    for (let i = 0; i < 3; i += 1) {
      await w.watch.tick()
      w.clock.advance(15000)
    }
    expect(w.sent).toHaveLength(1)
  })

  it('ложная тревога закрывается САМИМ сторожем: воскресать некому, процесс тот же', async () => {
    const config = scratchConfig()
    const w = watchOver({
      config,
      // подъём над живой дверью ничего не поднимает — процесс остаётся прежним
      liftChangesPid: false,
      answers: [
        { answered: false, kind: 'refused' },
        { answered: false, kind: 'refused' },
        { answered: false, kind: 'refused' },
        { answered: true, status: 200 },
      ],
    })
    for (let i = 0; i < 3; i += 1) {
      await w.watch.tick()
      w.clock.advance(15000)
    }
    expect(readOutage({ config })).not.toBeNull() // провал открыт

    const back = await w.watch.tick()
    expect(back.phase).toBe('back')
    expect(readOutage({ config })).toBeNull() // и закрыт — а не оставлен висеть навсегда
    expect(w.lines.join(' ')).toContain('тревога была ложной')

    const dir = outageReceiptsDir(config)
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
    expect(files).toHaveLength(1)
    const receipt = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
    // квитанция НАЗЫВАЕТ исход: без этого поля она читается как «падение было и кончилось»
    expect(receipt.falseAlarm).toBe(true)
  })

  it('сторож спрашивает у ДЕШЁВОЙ двери, а не у той, что собирает всю доску', async () => {
    const asked: string[] = []
    const watch = createWatch({
      config: scratchConfig(),
      probe: async (cfg: Record<string, unknown>) =>
        probeDoor({
          config: cfg,
          path: KNOCK_PATH,
          timeoutMs: KNOCK_TIMEOUT_MS,
          fetchImpl: async (url: string) => {
            asked.push(String(url))
            return { status: 200, json: async () => ({}) } as unknown as Response
          },
        }),
      readRecord: () => ({ pid: 1, bind: '127.0.0.1', port: 7791, startedAt: '', path: '' }),
      spawnLift: () => {},
      notify: async () => ({ sent: true, reason: '' }),
    })
    await watch.tick()
    expect(asked).toHaveLength(1)
    expect(asked[0].endsWith('/')).toBe(true)
    expect(asked[0]).not.toContain('/api/state')
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
      isAlive: () => false, // запись мёртвого процесса: у настоящей системы про номер 7 не спрашиваем
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

// ── «ПОДЪЁМ ЗАПУЩЕН» И «ПОДЪЁМ УДАЛСЯ» — РАЗНЫЕ ФАКТЫ ────────────────────────────
//
// НОЧЬ НА 29.08, живьём. Демон умер. Сторож отработал безупречно: заметил молчание за тридцать
// секунд, написал владельцу, запустил подъём и записал попытку со словом «ok». Через десять
// минут дверь всё ещё молчала, а в журнале скрипта подъёма не было НИ ОДНОЙ строки — процесс
// не начался вовсе. «ok» означало лишь, что вызов запуска не бросил исключения; над отделённым
// от родителя процессом с выброшенным выводом провал старта невидим по построению. Человеку
// было сказано «падение» и не сказано, что подъём не состоялся, — и картина в телеграме до
// утра оставалась «упал, поднимаю».
//
// Проверяется всё это ПОДДЕЛКОЙ ЗАПУСКА, КОТОРАЯ МОЛЧА НИЧЕГО НЕ ДЕЛАЕТ: вызов возвращается
// без исключения, дверь не отвечает никогда. Ровно та ночь, только на часах, которые двигает
// прогон.

describe('сторож — запущенный подъём доводится до исхода, а не до слова «ok»', () => {
  function deadLift({
    config = scratchConfig(),
    clock = clockFrom(T0),
    output = '',
    spawnThrows = false,
    notifyFails = false,
  }: {
    config?: Record<string, unknown>
    clock?: ReturnType<typeof clockFrom>
    output?: string
    spawnThrows?: boolean
    notifyFails?: boolean
  } = {}) {
    const sent: Array<{ text: string; at: number }> = []
    const lifts: number[] = []
    const lines: string[] = []
    const watch = createWatch({
      config,
      // дверь молчит ВСЕГДА: сколько ни поднимай, никто не отвечает
      probe: async () => ({ answered: false, status: 0, state: null, reason: 'ECONNREFUSED', kind: 'refused' }),
      readRecord: () => ({ pid: 4242, bind: '127.0.0.1', port: 7791, startedAt: '', path: '' }),
      isAlive: () => false, // здесь демон МЁРТВ: гасить некого, и настоящий номер 4242 не трогаем
      lift: { cmd: 'подъём', args: ['раз'], cwd: '.' },
      spawnLift: () => {
        if (spawnThrows) throw new Error('powershell не найден')
        lifts.push(clock.now())
        return { log: '/logs/daemon-lift-20260829.log' }
      },
      readLiftOutput: () => output,
      notify: async ({ text }: { text: string }) => {
        sent.push({ text, at: clock.now() })
        return notifyFails ? { sent: false, reason: 'телеграм отказал' } : { sent: true, reason: '' }
      },
      now: clock.now,
      log: (l: string) => lines.push(l),
      missesToDeclare: 1,
      liftCooldownMs: 120000,
      liftDoorWaitMs: 90000,
      liftAttemptsMax: 3,
    })
    return { watch, sent, lifts, lines, config, clock }
  }

  it('запущенный подъём лежит в записи БЕЗ исхода: «ok» не выдумывается на пустом месте', async () => {
    const w = deadLift()
    const declared = await w.watch.tick()
    expect(declared.phase).toBe('declared')
    expect(declared.outage!.lifts).toHaveLength(1)
    expect(declared.outage!.lifts[0].outcome).toBe('pending')
    expect(declared.outage!.lifts[0].ok).toBeUndefined() // слова, стоившего той ночи, больше нет
  })

  it('подъём, не породивший живой двери, получает исход «не удался» — и он ложится на диск', async () => {
    const w = deadLift()
    await w.watch.tick()
    w.clock.advance(90000) // отпущенное время вышло, дверь всё молчит
    const round = await w.watch.tick()

    expect(round.outage!.lifts[0].outcome).toBe('no-door')
    // исход обязан пережить сторожа: его читает и поднявшийся, и следующий сторож
    expect((readOutage({ config: w.config })!.lifts[0] as { outcome: string }).outcome).toBe('no-door')
    expect(w.lines.join(' ')).toContain('подъём НЕ УДАЛСЯ')
  })

  it('исход не объявляется раньше срока: демон в середине boot’а — ещё не провалившийся подъём', async () => {
    const w = deadLift()
    await w.watch.tick()
    w.clock.advance(60000) // меньше отпущенного
    const round = await w.watch.tick()
    expect(round.phase).toBe('down')
    expect(round.outage!.lifts[0].outcome).toBe('pending')
    expect(w.sent).toHaveLength(1) // и человека вторым сообщением пока не тревожат
  })

  it('после неудачи уходит ВТОРОЕ сообщение человеку — с причиной из вывода самого запуска', async () => {
    const w = deadLift({ output: 'Program «node» not found' })
    await w.watch.tick()
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0].text).toContain('Демон не отвечает')

    w.clock.advance(90000)
    await w.watch.tick()

    expect(w.sent).toHaveLength(2)
    expect(w.sent[1].text).toContain('Поднять не смог')
    expect(w.sent[1].text).toContain('Program «node» not found')
    expect(w.sent[1].text).toContain('Повторю через')
  })

  it('и о втором сообщении человеку обещано в первом: «не выйдет — скажу», а не тишина', () => {
    expect(fallWords({ downAt: new Date(T0).toISOString(), door: 'http://127.0.0.1:7791' })).toContain(
      'скажу об этом отдельным сообщением',
    )
  })

  it('запуск не оставил ни строки — это и сказано человеку: пустой журнал сам по себе улика', async () => {
    const w = deadLift({ output: '' })
    await w.watch.tick()
    w.clock.advance(90000)
    await w.watch.tick()

    expect(w.sent[1].text).toContain('не оставил ни строки')
    expect(w.sent[1].text).toContain('daemon-lift-20260829.log') // и назван файл, в котором её нет
  })

  it('о неудаче говорится один раз за провал, а не на каждом круге', async () => {
    const w = deadLift()
    await w.watch.tick()
    for (let i = 0; i < 6; i += 1) {
      w.clock.advance(90000)
      await w.watch.tick()
    }
    // два сообщения о неудаче на один провал — это шум, обесценивающий и первое
    expect(w.sent.filter((m) => m.text.includes('Поднять не смог')).length).toBeLessThanOrEqual(2)
  })

  it('повтор идёт с ВЫДЕРЖКОЙ, и выдержка растёт: второй удар не бьёт в ту же секунду', async () => {
    const w = deadLift()
    await w.watch.tick() // T0: провал объявлен, подъём 1
    expect(w.lifts).toHaveLength(1)

    w.clock.advance(90000) // T0+90 с: исход первого назван, но выдержка ещё идёт
    expect((await w.watch.tick()).phase).toBe('down')
    expect(w.lifts).toHaveLength(1)

    w.clock.advance(30000) // T0+2 мин: выдержка вышла
    expect((await w.watch.tick()).phase).toBe('lifting')
    expect(w.lifts).toHaveLength(2)

    w.clock.advance(90000) // исход второго
    expect((await w.watch.tick()).phase).toBe('down')
    w.clock.advance(90000) // на прежней выдержке подъём был бы уже здесь
    expect((await w.watch.tick()).phase).toBe('down')
    expect(w.lifts).toHaveLength(2)

    w.clock.advance(60000) // а он там, где удвоенная: 4 мин после второй попытки
    expect((await w.watch.tick()).phase).toBe('lifting')
    expect(w.lifts).toHaveLength(3)
  })

  it('после трёх неудач сторож ЗОВЁТ ЧЕЛОВЕКА и перестаёт крутить цикл', async () => {
    const w = deadLift()
    await w.watch.tick()
    for (const step of [90000, 30000, 90000, 150000, 90000]) {
      w.clock.advance(step)
      await w.watch.tick()
    }
    expect(w.lifts).toHaveLength(3)
    expect(w.sent).toHaveLength(3)
    expect(w.sent[2].text).toContain('Больше не пробую')
    expect(w.sent[2].text).toContain('npm run daemon:restart')

    // и дальше — ни одной попытки и ни одного слова, сколько ни жди
    for (let i = 0; i < 5; i += 1) {
      w.clock.advance(600000)
      expect((await w.watch.tick()).phase).toBe('abandoned')
    }
    expect(w.lifts).toHaveLength(3)
    expect(w.sent).toHaveLength(3)
    expect(readOutage({ config: w.config })!.liftGaveUpAt).not.toBeNull()
  })

  it('сторож, перезапущенный после отказа, не начинает цикл заново', async () => {
    const first = deadLift()
    await first.watch.tick()
    for (const step of [90000, 30000, 90000, 150000, 90000]) {
      first.clock.advance(step)
      await first.watch.tick()
    }
    expect(first.lifts).toHaveLength(3)

    const second = deadLift({ config: first.config, clock: clockFrom(T0 + 3600000) })
    const round = await second.watch.tick()
    expect(round.phase).toBe('abandoned')
    expect(second.lifts).toHaveLength(0) // потолок попыток живёт в записи, а не в памяти процесса
  })

  it('бросок на самом вызове — исход, известный сразу: ждать двери не от кого', async () => {
    const w = deadLift({ spawnThrows: true })
    const round = await w.watch.tick()
    expect(round.outage!.lifts[0].outcome).toBe('no-spawn')
    expect(w.sent).toHaveLength(2)
    expect(w.sent[1].text).toContain('Поднять не смог')
    expect(w.sent[1].text).toContain('powershell не найден')
  })

  it('телеграм отказал на неудавшемся подъёме — отказ назван и второй раз не повторяется', async () => {
    const w = deadLift({ notifyFails: true })
    await w.watch.tick()
    w.clock.advance(90000)
    await w.watch.tick()
    const marker = readOutage({ config: w.config })!
    expect(marker.liftFailNotifiedAt).toBeNull()
    expect(marker.liftFailNotice).toBe('телеграм отказал')
  })

  it('дверь, ответившая в отпущенный срок, и есть исход: квитанция несёт «up», а не «не знаю»', () => {
    const config = scratchConfig()
    const opened = openOutage({ config, downAt: T0, now: () => T0 })
    const stamped = stampOutage({
      config,
      marker: opened,
      patch: { lifts: [{ at: new Date(T0 + 1000).toISOString(), cmd: 'подъём', outcome: 'pending' }] },
    })
    const { receipt } = closeOutage({
      config,
      marker: stamped,
      doorBackAt: T0 + 40000,
      roseAt: T0 + 39000,
      now: () => T0 + 40000,
    })
    expect(receipt.lifts[0].outcome).toBe('up')
    expect(receipt.lifts[0].doorAt).toBe(new Date(T0 + 40000).toISOString())
  })

  it('ложная тревога называет подъём своим словом: поднимать было нечего', () => {
    const config = scratchConfig()
    const opened = openOutage({ config, downAt: T0, now: () => T0 })
    const stamped = stampOutage({
      config,
      marker: opened,
      patch: { lifts: [{ at: new Date(T0 + 1000).toISOString(), cmd: 'подъём', outcome: 'pending' }] },
    })
    const { receipt } = closeOutage({
      config,
      marker: stamped,
      doorBackAt: T0 + 40000,
      falseAlarm: true,
      now: () => T0 + 40000,
    })
    expect(receipt.lifts[0].outcome).toBe('no-need')
  })
})

// ── ВЫВОД ЗАПУСКА: ЕСТЬ КУДА ПИСАТЬ И ЕСТЬ ГДЕ ПРОЧЕСТЬ ──────────────────────────

describe('журнал запусков — вывод подъёма попадает в файл, а не выбрасывается', () => {
  const scratchLogDir = () => join(mkdtempSync(join(tmpdir(), 'sma-lift-')), 'logs')

  it('у запуска есть свой дневной файл — на любой платформе, без развилки «а на Windows в никуда»', () => {
    const logDir = scratchLogDir()
    const opened = openLiftLog(logDir, { at: new Date(T0) })
    expect(opened.log).toBe(join(logDir, 'daemon-lift-20260828.log'))
    expect(opened.stdio).not.toBe('ignore')
    expect(Array.isArray(opened.stdio)).toBe(true)
    opened.close()
    expect(existsSync(opened.log)).toBe(true)
  })

  it('ошибка запуска приходит СОБЫТИЕМ, а не броском, — и всё равно ложится в журнал', () => {
    const logDir = scratchLogDir()
    const handlers: Record<string, (...a: unknown[]) => void> = {}
    // Так `spawn` и сообщает о несостоявшемся запуске: не исключением, которое можно поймать
    // вокруг вызова, а событием потом. Отсюда и «ok» той ночи — ловить было нечего.
    const fakeSpawn = () => ({
      on(ev: string, fn: (...a: unknown[]) => void) {
        handlers[ev] = fn
        return this
      },
      unref() {},
    })
    const { log } = spawnLiftLogged({
      spawn: fakeSpawn as never,
      lift: { cmd: 'powershell', args: ['-File', 'start-daemon-windows.ps1'], cwd: '.' },
      logDir,
      at: new Date(T0),
    })
    handlers.error(new Error('spawn powershell ENOENT'))

    const tail = tailLiftLog(log)
    expect(tail).toContain('ЗАПУСК НЕ СОСТОЯЛСЯ')
    expect(tail).toContain('ENOENT')
    expect(tail).toContain('powershell -File start-daemon-windows.ps1') // видно, ЧТО не запустилось
  })

  it('хвост ограничен: сообщение, не влезающее в экран телефона, — то же молчание, только длиннее', () => {
    const logDir = scratchLogDir()
    const opened = openLiftLog(logDir, { at: new Date(T0) })
    opened.close()
    for (let i = 0; i < 40; i += 1) noteLift(opened.log, `строка ${i}`)
    const tail = tailLiftLog(opened.log)
    expect(tail.split('\n')).toHaveLength(12)
    expect(tail).toContain('строка 39')
    expect(tail).not.toContain('строка 27')
  })

  it('ни один запуск подъёма больше не решает сам, что на Windows вывод не нужен', () => {
    // Развилка `if (win32) return 'ignore'` стояла в обоих запусках под предлогом «.ps1 ведёт
    // журнал сам». Ведёт — если запустилась; ночью на 29.08 не запустилась именно она.
    for (const name of ['daemon-watch.mjs', 'daemon-control.mjs']) {
      const src = readFileSync(new URL(`../../supervisor/${name}`, import.meta.url), 'utf8')
      expect(src).not.toContain("'ignore'")
      expect(src).toContain('spawnLiftLogged')
    }
  })

  it('решение «отделять ли» едет ВМЕСТЕ с командой и доезжает до самого spawn', () => {
    // Провод, которого не было. Отделение стояло здесь константой `detached: true`, и на
    // Windows это DETACHED_PROCESS — «консоли не давать». PowerShell 5.1 без консоли не
    // стартует: замерено 02.09.2026 трижды — процесс создан, вышел с нулём за миллисекунды,
    // не выполнив ни строки скрипта, и не написал ни слова никуда. Значение из команды должно
    // доезжать до вызова, иначе развилка вычислена и не подключена.
    const logDir = scratchLogDir()
    const seen: Array<Record<string, unknown>> = []
    const fakeSpawn = (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      seen.push(opts)
      return { pid: 4242, on() { return this }, unref() {} }
    }
    spawnLiftLogged({
      spawn: fakeSpawn as never,
      lift: { cmd: 'powershell', args: ['-File', 'lift-daemon-windows.ps1'], cwd: '.', detached: false },
      logDir,
      at: new Date(T0),
    })
    spawnLiftLogged({
      spawn: fakeSpawn as never,
      lift: { cmd: 'node', args: ['main.mjs'], cwd: '.', detached: true },
      logDir,
      at: new Date(T0),
    })
    // Команда без своего мнения ведёт себя как раньше — старые вызовы не меняют поведения.
    spawnLiftLogged({
      spawn: fakeSpawn as never,
      lift: { cmd: 'node', args: ['main.mjs'], cwd: '.' },
      logDir,
      at: new Date(T0),
    })
    expect(seen.map((o) => o.detached)).toEqual([false, true, true])
  })

  it('выход запуска попадает в журнал ДАЖЕ с нулевым кодом — смерть за миллисекунды это улика', () => {
    // `if (code || signal)` глотал ровно тот случай, ради которого журнал заводился: обёртка
    // выходила с нулём, не сделав ничего. Теперь в журнале и код, и время жизни, и pid.
    const logDir = scratchLogDir()
    const handlers: Record<string, (...a: unknown[]) => void> = {}
    const fakeSpawn = () => ({
      pid: 777,
      on(ev: string, fn: (...a: unknown[]) => void) {
        handlers[ev] = fn
        return this
      },
      unref() {},
    })
    let clock = 1000
    const { log } = spawnLiftLogged({
      spawn: fakeSpawn as never,
      lift: { cmd: 'powershell', args: ['-File', 'start-daemon-windows.ps1'], cwd: '.', detached: true },
      logDir,
      at: new Date(T0),
      now: () => clock,
    })
    clock = 1020
    handlers.exit(0, null)

    const tail = tailLiftLog(log)
    expect(tail).toContain('pid 777')
    expect(tail).toContain('код 0')
    expect(tail).toContain('20 мс')
  })

  it('файла нет — пустая строка, а не бросок: журнал это удобство, а не условие подъёма', () => {
    expect(tailLiftLog(join(scratchLogDir(), 'нет-такого.log'))).toBe('')
    expect(tailLiftLog('')).toBe('')
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
