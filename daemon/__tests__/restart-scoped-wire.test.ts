/**
 * НАСТРОЙКА, КОТОРАЯ ПРИМЕНИТСЯ ТОЛЬКО ПРИ ПЕРЕЗАПУСКЕ, ГОВОРИТ ЭТО САМА — И ГОВОРИТ,
 * КОГДА ФАЙЛ И ПАМЯТЬ РАЗОШЛИСЬ.
 *
 * ПОВОД — ДВА СЛУЧАЯ ПОДРЯД, ВТОРОЙ В НОЧЬ НА 29.08.2026.
 *   Первый: владелец опустил потолок одновременных мест и увидел, что ничего не изменилось.
 *   Настройка была записана, показана и не действовала — демон читает файл ОДИН раз, при
 *   запуске, и дальше живёт копией.
 *   Второй, той же ночью: потолок ходов подняли со 160 до 400, чтобы разорвать круг
 *   сгоравших работ; через час в файле снова стояло 160. Бегущий демон затёр правку своей
 *   устаревшей копией — и это при том, что починка такой записи уже была в стволе: демон
 *   стартовал раньше неё. Даже почина не помогает, пока никто не сказал человеку, что в
 *   ЭТОМ процессе её ещё нет.
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ, И ЧЕГО НЕ ХВАТИЛО БЫ. Не «в ответе есть поле»: поле, собранное из
 * одной копии настроек, всегда сходится само с собой и молчит ровно в том случае, ради
 * которого заведено. Поэтому каждое дело ниже держит ДВА РАЗНЫХ значения — то, что лежит в
 * файле, и то, по которому демон работает, — и спрашивает дверь состояния, видно ли между
 * ними разницу. Подделка здесь именно на расхождении, а не на совпадении.
 *
 * И ВТОРАЯ ПОЛОВИНА: список таких настроек ОДИН. Ни дверь, ни экран не пишут своего — иначе
 * однажды помечены будут не те настройки, и человек снова сделает вывод по молчанию.
 *
 * Ни демона, ни базы, ни сети: очередь подставная, файл настроек — обычный временный файл.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import { RESTART_SCOPED, deriveRestartScoped, readConfigOnDisk } from '../src/config-restart.mjs'
import { deriveState } from '../src/front/state.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { concurrencyCap } from '../src/queue/in-flight.mjs'
import { pipelineMaxTurns } from '../src/config.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TOKEN = 'd'.repeat(64)

const scratch: string[] = []
const scratchDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sma-restart-scoped-'))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** Очередь, у которой дверь состояния спрашивает только list(). Это дело не про задачи. */
const emptyQueue = { list: async () => [] }

/** Копия настроек, по которой демон РАБОТАЕТ — прочитанная на запуске и с тех пор своя. */
const running = (over: any = {}) => ({ token: TOKEN, workers: [], ...over })

/** Один опрос двери состояния — тем же derive, каким её отвечает настоящий демон. */
const ask = (config: any, configOnDisk: any) =>
  deriveState({
    adapter: emptyQueue,
    config,
    clock: () => 1_777_000_000_000,
    ...(configOnDisk === undefined ? {} : { configOnDisk }),
  }) as Promise<any>

const rowsOf = (payload: any) => {
  const byId: Record<string, any> = {}
  for (const row of payload.rules.restartScoped) byId[row.id] = row
  return byId
}

describe('расхождение файла и памяти доезжает до двери состояния', () => {
  it('в файле одно, работаю по другому — и дверь называет ОБА числа', async () => {
    // Ровно ночной случай: в файле человек поставил 400, демон живёт со 160, прочитанными
    // при запуске. Числа РАЗНЫЕ — иначе дело доказывало бы только то, что копия равна себе.
    const payload = await ask(running({ maxConcurrentAttempts: 6, pipeline: { maxTurns: 160 } }), () => ({
      maxConcurrentAttempts: 4,
      pipeline: { maxTurns: 400 },
    }))
    const byId = rowsOf(payload)

    expect(byId['pipeline.maxTurns']).toMatchObject({ running: 160, onDisk: 400, diverged: true })
    expect(byId.maxConcurrentAttempts).toMatchObject({ running: 6, onDisk: 4, diverged: true })
  })

  it('«работаю по» — ТО ЖЕ выражение, каким число читает машина, а не второе мнение экрана', async () => {
    const config = running({ maxConcurrentAttempts: 6, pipeline: { maxTurns: 160 } })
    const payload = await ask(config, () => ({ maxConcurrentAttempts: 4, pipeline: { maxTurns: 400 } }))
    const byId = rowsOf(payload)

    // Потолок мест — тем же чтением, которым тик отказывает в месте, и тем же числом,
    // которое дверь уже называет как «мест всего». Два написания одной настройки однажды
    // разойдутся, и разойдутся ровно тогда, когда человек по ней и делает вывод.
    expect(byId.maxConcurrentAttempts.running).toBe(concurrencyCap(config))
    expect(byId.maxConcurrentAttempts.running).toBe(payload.kpis.seatsTotal)
    expect(byId['pipeline.maxTurns'].running).toBe(pipelineMaxTurns(config))
  })

  it('расхождение доезжает до ДВЕРИ, а не остаётся в derive: /api/state отвечает им телом', async () => {
    const front = createFrontServer({
      config: running({ maxConcurrentAttempts: 6 }),
      deps: {
        adapter: emptyQueue,
        deriveState,
        // ШОВ ПЕРЕСЫЛАЕТСЯ ДВЕРЬЮ. Именно этого звена и не хватало во всех четырёх случаях
        // «посчитано и не подключено»: derive умеет, дверь не пересылает, экран пуст.
        configOnDisk: () => ({ maxConcurrentAttempts: 4 }),
      },
    })
    const req: any = Readable.from([])
    req.method = 'GET'
    req.url = '/api/state'
    req.headers = { authorization: `Bearer ${TOKEN}` }
    req.socket = { remoteAddress: '10.0.0.1' }
    const res: any = {
      statusCode: 0,
      body: '',
      headersSent: false,
      writeHead(code: number) {
        res.statusCode = code
        res.headersSent = true
        return res
      },
      setHeader() {},
      getHeader() {
        return undefined
      },
      write(c: any) {
        res.body += String(c)
        return true
      },
      end(c?: any) {
        if (c != null) res.body += String(c)
        return res
      },
    }

    await front.handle(req, res)
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    const seats = out.rules.restartScoped.find((s: any) => s.id === 'maxConcurrentAttempts')
    expect(seats, 'дверь обязана отдать строку настройки, а не только посчитать её').toBeTruthy()
    expect(seats).toMatchObject({ running: 6, onDisk: 4, diverged: true })
  })

  it('файл читается НА КАЖДЫЙ опрос — запомненный ответ повторил бы сам дефект', async () => {
    // Человек правит файл при живом демоне: если дверь прочитает файл один раз и запомнит,
    // она будет показывать ту же устаревшую копию, из-за которой всё и затевалось.
    let disk: any = { maxConcurrentAttempts: 4 }
    let reads = 0
    const seam = () => {
      reads += 1
      return disk
    }
    const config = running({ maxConcurrentAttempts: 4 })

    const before = rowsOf(await ask(config, seam))
    expect(before.maxConcurrentAttempts.diverged, 'пока числа равны — расхождения нет').toBe(false)

    disk = { maxConcurrentAttempts: 9 } // человек поправил файл, демон работает дальше
    const after = rowsOf(await ask(config, seam))

    expect(reads, 'каждый опрос — своё чтение файла').toBe(2)
    expect(after.maxConcurrentAttempts).toMatchObject({ running: 4, onDisk: 9, diverged: true })
  })
})

describe('совпадающие значения расхождением не считаются', () => {
  it('одно и то же число в файле и в памяти — это не расхождение', async () => {
    const byId = rowsOf(
      await ask(running({ maxConcurrentAttempts: 4, pipeline: { maxTurns: 400 } }), () => ({
        maxConcurrentAttempts: 4,
        pipeline: { maxTurns: 400 },
      })),
    )
    expect(byId.maxConcurrentAttempts).toMatchObject({ running: 4, onDisk: 4, diverged: false })
    expect(byId['pipeline.maxTurns']).toMatchObject({ running: 400, onDisk: 400, diverged: false })
  })

  it('ключа нет ни там, ни там — работает умолчание, и перезапуск ничего не изменит', async () => {
    // Сравниваются ЭФФЕКТИВНЫЕ значения, а не наличие ключей: пустой блок в файле и пустой
    // блок в памяти дают одно и то же число, и кричать тут не о чем.
    const byId = rowsOf(await ask(running(), () => ({ workers: [] })))
    expect(byId.maxConcurrentAttempts.diverged).toBe(false)
    expect(byId['pipeline.maxTurns'].diverged).toBe(false)
    expect(byId['pipeline.maxTurns'].running).toBe(pipelineMaxTurns({}))
  })

  it('мусор в файле читается тем же выражением — умолчание против умолчания не расходится', async () => {
    // `maxTurns: "много"` машина уже отвергает в пользу умолчания. Значит после перезапуска
    // будет ТО ЖЕ число, и объявлять это расхождением — врать человеку во второй раз.
    const byId = rowsOf(await ask(running(), () => ({ pipeline: { maxTurns: 'много' } })))
    expect(byId['pipeline.maxTurns']).toMatchObject({ running: 80, onDisk: 80, diverged: false })
  })

  it('файл прочитать не удалось — это «сравнивать не с чем», а не «всё совпадает»', async () => {
    const silent = rowsOf(await ask(running({ maxConcurrentAttempts: 6 }), undefined))
    expect(silent.maxConcurrentAttempts.onDisk, 'про файл ничего не сказано').toBe(null)
    expect(silent.maxConcurrentAttempts.diverged, 'утверждение о файле без файла делать нельзя').toBe(false)
    expect(silent.maxConcurrentAttempts.running, '…а по чему работаем — известно всегда').toBe(6)

    // …и шов, который бросил, роняет не дверь, а только своё утверждение
    const thrown = rowsOf(
      await ask(running({ maxConcurrentAttempts: 6 }), () => {
        throw new Error('файл переписывается прямо сейчас')
      }),
    )
    expect(thrown.maxConcurrentAttempts).toMatchObject({ onDisk: null, diverged: false, running: 6 })
  })
})

describe('настройка называет себя применяемой при перезапуске, и список таких настроек ОДИН', () => {
  it('пометка стоит на КАЖДОЙ строке, а не подразумевается заголовком', async () => {
    const payload = await ask(running(), () => ({}))
    expect(payload.rules.restartScoped.length).toBeGreaterThan(0)
    for (const row of payload.rules.restartScoped) {
      expect(row.applies, `настройка ${row.id} обязана назвать себя сама`).toBe('restart')
      expect(String(row.label).trim(), 'у настройки есть имя словами — человек читает не ключ').not.toBe('')
      expect(String(row.why).trim(), 'и одна фраза, почему она не может примениться на лету').not.toBe('')
    }
  })

  it('список на экране — ЭТО реестр, а не его копия', async () => {
    const payload = await ask(running(), () => ({}))
    expect(payload.rules.restartScoped.map((s: any) => s.id)).toEqual(RESTART_SCOPED.map((s) => s.id))
  })

  it('ни дверь, ни экран не пишут своего списка — иначе однажды помечены будут не те настройки', () => {
    // Второй список — это не дубль, это РАСХОЖДЕНИЕ, отложенное во времени: настройка
    // добавляется в одном месте, а помечается по другому, и молчание возвращается.
    const ids = RESTART_SCOPED.map((s) => s.id)
    const derive = readFileSync(join(ROOT, 'daemon', 'src', 'front', 'state.mjs'), 'utf8')
    const screen = readFileSync(join(ROOT, 'spa', 'src', 'screens', 'system', 'index.tsx'), 'utf8')
    for (const id of ids) {
      expect(derive.includes(id), `дверь состояния не должна писать «${id}» своими руками`).toBe(false)
      expect(screen.includes(id), `экран не должен знать про «${id}» — он рисует то, что приехало`).toBe(false)
    }
  })
})

describe('чтение файла настроек — тем же путём, каким его нашёл сам демон', () => {
  it('путь берётся из окружения, и разобранный файл возвращается как есть', () => {
    const dir = scratchDir()
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ maxConcurrentAttempts: 4, pipeline: { maxTurns: 400 } }), 'utf8')

    const onDisk: any = readConfigOnDisk({ env: { SMA_DAEMON_CONFIG: path } })
    expect(onDisk.maxConcurrentAttempts).toBe(4)
    expect(onDisk.pipeline.maxTurns).toBe(400)

    // …и это ровно то, из чего дальше считается расхождение
    const rows = deriveRestartScoped({ maxConcurrentAttempts: 6 }, onDisk)
    expect(rows.find((r) => r.id === 'maxConcurrentAttempts')).toMatchObject({ running: 6, onDisk: 4, diverged: true })
  })

  it('нет файла, битый файл, не-объект — это null, а не пустой объект', () => {
    const dir = scratchDir()
    expect(readConfigOnDisk({ env: { SMA_DAEMON_CONFIG: join(dir, 'нет-такого.json') } })).toBe(null)

    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ это не json', 'utf8')
    expect(readConfigOnDisk({ env: { SMA_DAEMON_CONFIG: broken } })).toBe(null)

    const list = join(dir, 'list.json')
    writeFileSync(list, '[1,2,3]', 'utf8')
    expect(readConfigOnDisk({ env: { SMA_DAEMON_CONFIG: list } })).toBe(null)
  })
})
