/**
 * СТАРТ СЕССИИ: СВОЙ TEMP, ЧЕСТНОЕ ВРЕМЯ ДО ПЕРВОГО СЛОВА, ГАШЕНИЕ ДЕРЕВА И ТУМБЛЕР В МОМЕНТ
 * ЗАПУСКА — ЧЕТЫРЕ ПРОВОДА ОДНОГО ЖИВОГО ЗАМЕРА.
 *
 * ЧТО СЛУЧИЛОСЬ ЖИВЬЁМ 02.09.2026, И ПОЧЕМУ ЭТОТ ФАЙЛ ВЫГЛЯДИТ ИМЕННО ТАК. Журнал песочницы
 * дома задачи: 14:37:41Z право записи выдано на копию работника и на git-каталог копии — оба
 * дерева маленькие, обход занял чуть больше секунды. Затем 14:41:00Z то же право выдаётся на
 * ОБЩИЙ временный каталог пользователя: Windows-песочница считает его писаемым корнем и обходит
 * целиком. Четыре минуты в этом запуске, семнадцать минут в полуденном — до первого слова
 * сессии, на идущем окне подписки, и снаружи это неотличимо от повисшего работника. В тот же
 * час выяснились ещё две вещи: помощник песочницы от СНЯТОЙ попытки (отмена в 14:36) жил с
 * мёртвым родителем и молотил права ещё 193 секунды процессорного времени — «умерла для учёта,
 * жива для денег»; а выключенный работник взял чужую задачу через две секунды после того, как
 * тумблер сняли, потому что решение о нём было принято раньше и больше не перепроверялось.
 *
 * ЧЕТЫРЕ УТВЕРЖДЕНИЯ, И НИ ОДНО ИЗ НИХ — ПРО ФАЙЛЫ ЭТОЙ ЖЕ РАБОТЫ:
 *
 *   (1) окружение, С КОТОРЫМ ТИК ПРАВДА СПАВНИТ, несёт Temp внутри дома ЭТОЙ задачи, и этот
 *       каталог лежит на диске — команда собрана настоящим композитором, не подделкой;
 *   (2) отмена живой попытки отдаёт приказ ДЕРЕВУ процессов, а не одному pid, и отдаёт его
 *       ПЕРВЫМ — пока родитель жив и помощника ещё есть с чего найти;
 *   (3) на долговечной строке попытки стоит время от запуска до первого кадра, словами;
 *   (4) тумблер, снятый ПОКА попытка готовилась, останавливает её ДО спавна: процесса не
 *       существует вовсе, а на карточке стоит названная причина.
 *
 * Тик настоящий, git настоящий, леджер читается настоящим читателем с диска. Платформа
 * инжектируется, поэтому ветка Windows гоняется на любой машине.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick, steeredSpawn, sessionStartRecord, workerSwitchedOffNow } from '../src/loop.mjs'
import { spawnWorker, killProcessTree } from '../src/runner/spawn.mjs'
import { createBuildArgs } from '../src/runner/build-args.mjs'
import { codexHomeFor, codexTempFor, buildCodexArgs } from '../src/runner/args.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue, REASON_LABELS, failureAwaitsAPerson } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { createTurnRegistry } from '../src/front/chat.mjs'
import { createFrontServer } from '../src/front/server.mjs'
import { Readable } from 'node:stream'

// ── временный мир ──────────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
const mkDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* уборка не роняет сьют */
    }
  }
})

const git = (args: string[], cwd: string) =>
  String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '')

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

/** Копия работника: настоящий репозиторий, база и один коммит на ветке задачи. */
const makeCopy = () => {
  const dir = mkDir('sma-sessionstart-copy-')
  git(['init', '-q', '.'], dir)
  git(['config', 'user.email', 'wire@test'], dir)
  git(['config', 'user.name', 'wire'], dir)
  git(['config', 'core.autocrlf', 'false'], dir)
  writeFileSync(join(dir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')
  git(['add', 'CLAUDE.md'], dir)
  git(['commit', '-qm', 'база'], dir)
  const base = git(['rev-parse', 'HEAD'], dir).trim()
  git(['checkout', '-q', '-b', 'wt/BL-1'], dir)
  writeFileSync(join(dir, 'product.txt'), 'работа сделана\n', 'utf8')
  git(['add', 'product.txt'], dir)
  git(['commit', '-qm', 'работа'], dir)
  return { dir, base }
}

// Форма кадра полосы codex — та же, что у живого `codex exec --json`.
const codexSaid = (text: string) =>
  JSON.stringify({ type: 'item.completed', item: { id: 'it_1', type: 'agent_message', text } })

const NOTE = 'APPROACH_NOTE: разобрал и починил провод'
const LESSON = 'LESSON_NONE: урок уже записан в предыдущей попытке'

const CODEX_WORKER = {
  id: 'pro-1',
  lane: 'prod',
  provider: 'codex',
  enabled: true,
  account: { name: 'pro-1', configDir: '', spendLogsDir: '' },
}

const backlogTask = (over: Record<string, unknown> = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'работа на полосе codex',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
  ...over,
})

const GREEN_REVERIFY = {
  code: 0,
  stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+1 -0' }),
}

/**
 * Один настоящий тик по полосе codex.
 *
 * `realComposer` — собирать ли команду спавна НАСТОЯЩИМ композитором (createBuildArgs). Для
 * вопроса «доехал ли Temp до спавна» подделка не годится по построению: она отвечала бы из того
 * самого допущения, которое проверяется. Для остальных случаев берётся дешёвая подделка — там
 * предмет другой.
 *
 * `duringProvisioning` — рука человека, вмешавшаяся ПОКА попытка готовится: верб отведения
 * копии зовётся между маршрутом и спавном, то есть ровно в ту паузу, в которую 02.09.2026 сняли
 * тумблер.
 */
async function runTick(
  over: {
    realComposer?: boolean
    platform?: string
    lines?: string[]
    firstFrameAfterMs?: number
    duringProvisioning?: (world: { worker: Record<string, unknown>; config: Record<string, unknown> }) => void
  } = {},
) {
  const accountDir = mkDir('sma-sessionstart-acct-')
  const projectDir = mkDir('sma-sessionstart-proj-')
  const ledgerDir = mkDir('sma-sessionstart-ledger-')
  const copy = makeCopy()
  const workDir = copy.dir
  // Настоящий композитор откажет дому без логина (401), поэтому логин у счёта настоящий.
  writeFileSync(join(accountDir, 'auth.json'), '{"tokens":{"id_token":"subscription"}}', 'utf8')
  const worker = {
    ...CODEX_WORKER,
    account: { ...CODEX_WORKER.account, configDir: accountDir, spendLogsDir: join(accountDir, 'spend') },
  }

  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue(backlogTask())
  const logged: Record<string, unknown>[] = []
  const spawned: Record<string, unknown>[] = []
  const lines = over.lines ?? [codexSaid(`${NOTE}\n${LESSON}`)]

  const config: Record<string, unknown> = {
    workers: [worker],
    agingHours: 24,
    backlogScanMinutes: 60,
    repoDir: projectDir,
    pipeline: { enabled: true },
    // Полоса prod, ведущая в codex — та же расстановка, на которой всё это ломалось живьём.
    laneRouting: { prod: { provider: 'codex' } },
  }

  const fakeArgs = (_t: unknown, _r: unknown) => ({
    bin: 'codex',
    args: buildCodexArgs({ sandbox: 'read-only' }),
    env: { CODEX_HOME: codexHomeFor({ account: worker.account, taskId: 'BL-1' }), PATH: '/usr/bin' },
    prompt: 'сделай дело',
    workerId: worker.id,
    provider: 'codex',
  })

  const deps: Record<string, unknown> = {
    adapter,
    ledger: {
      recordAttempt: (row: unknown) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: { attemptId: string }) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config,
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    // Не-Windows: у песочницы этой машины нечего проверять, и случай остаётся о том, о чём он.
    platform: over.platform ?? 'linux',
    buildArgs: over.realComposer
      ? createBuildArgs({
          config,
          // Та же платформа, что у тика: у песочницы этой машины нечего проверять, и случай
          // остаётся о Temp, а не об элевированной установке.
          platform: over.platform ?? 'linux',
          env: { HOME: join(accountDir, 'empty-home'), USERPROFILE: join(accountDir, 'empty-home') },
          // Зеркало личного слоя отвечает подделкой, всё остальное — настоящим диском: композитор
          // и правда создаёт дом задачи, и утверждать про него можно по факту.
          fsImpl: {
            readFileSync: (p: string, enc: string) =>
              String(p).replace(/\\/g, '/').endsWith('settings.json')
                ? JSON.stringify({ disableClaudeAiConnectors: true })
                : readFileSync(p, enc as never),
          },
        })
      : fakeArgs,
    verbRunner: async (_bin: string, argsArray: string[]) => {
      const verb = argsArray[1]
      if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
      if (verb === 'worktree') {
        // ЗДЕСЬ, ВНУТРИ ПОДГОТОВКИ КОПИИ, И ЕСТЬ ТА ПАУЗА. Отведение копии — настоящая работа
        // на диске; в бою она занимает секунды, и человек, снимающий тумблер, попадает именно
        // сюда.
        if (over.duringProvisioning) over.duringProvisioning({ worker, config })
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            path: workDir,
            branch: 'wt/BL-1',
            expectedBase: copy.base,
            materialized: [],
          }),
        }
      }
      if (verb === 'reverify') return GREEN_REVERIFY
      return { code: 0, stdout: '{}' }
    },
    spawnWorker: (spec: Record<string, unknown>) => {
      spawned.push(spec)
      // МОЛЧАНИЕ ПЕРЕД ПЕРВЫМ СЛОВОМ — то самое, что песочница тратит на раздачу прав.
      if (over.firstFrameAfterMs) c.advance(over.firstFrameAfterMs)
      for (const l of lines) (spec.onLine as (l: string) => void)?.(l)
      ;(spec.onExit as (e: unknown) => void)?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    report: async () => {},
    clock: c.clock,
    journal: (e: Record<string, unknown>) => logged.push(e),
    execGit: (args: string[], opts: { cwd?: string } = {}) => git(args, opts.cwd || workDir),
  }

  const res = await tick(deps)
  const rows = readAttempts(ledgerDir, 'BL-1')
  return { res, row: rows[rows.length - 1], logged, spawned, worker, accountDir, workDir }
}

// ═══════════ (1) TEMP ЗАДАЧИ ДОЕЗЖАЕТ ДО СПАВНА ════════════════════════════════════════════

describe('песочнице выдаётся Temp этой задачи, а не общий каталог машины', () => {
  it('окружение, с которым тик ПРАВДА спавнит, называет Temp внутри дома задачи — и он есть на диске', async () => {
    const { spawned, worker } = await runTick({ realComposer: true })

    expect(spawned).toHaveLength(1) // процесс был — значит и окружение было
    const env = spawned[0].env as Record<string, string>
    const home = codexHomeFor({ account: worker.account, taskId: 'BL-1' })
    // ПРОВОД: не «функция умеет собрать путь», а «этим путём запущен процесс».
    expect(env.TEMP).toBe(codexTempFor(home))
    expect(env.TMP).toBe(codexTempFor(home))
    // И НАЗВАННЫЙ КАТАЛОГ СДЕЛАН. Названный и не сделанный отправил бы процесс обратно в общий.
    expect(existsSync(String(env.TEMP))).toBe(true)
  })

  it('это дерево — своё и пустое: раздавать права по нему нечего', async () => {
    const { spawned } = await runTick({ realComposer: true })
    const env = spawned[0].env as Record<string, string>
    // Каталог задачи, а не общий каталог пользователя, — вся суть починки одним утверждением.
    expect(String(env.TEMP).replace(/\\/g, '/')).toContain('codex-tasks/BL-1')
    expect(String(env.TEMP)).not.toBe(tmpdir())
  })
})

// ═══════════ (2) ОТМЕНА ГАСИТ ДЕРЕВО, А НЕ ОДИН pid ════════════════════════════════════════

describe('отмена живой попытки добивает и помощников песочницы', () => {
  /** Ребёнок-подделка: тот минимум, который спавн действительно трогает. */
  const fakeChild = (pid: number | undefined, killed: string[]) => ({
    pid,
    stdin: { write: () => {}, end: () => {} },
    stdout: { on: () => {} },
    on: () => {},
    kill: () => killed.push('одиночный pid'),
  })

  it('дверь отмены доезжает до приказа ДЕРЕВУ, а не до одного процесса', () => {
    const killed: string[] = []
    const treeOrders: number[] = []
    const registry = createTurnRegistry()

    // Настоящий запускатель, настоящая ручка руления, настоящий реестр ходов — подделаны
    // только сам процесс и системный приказ.
    const steered = steeredSpawn({ attemptTurns: registry }, 'BL-1', (o: Record<string, unknown>) =>
      spawnWorker({
        ...o,
        bin: 'codex',
        args: [],
        cwd: '/tmp/копия',
        env: {},
        spawnImpl: () => fakeChild(4242, killed),
        killTreeImpl: ({ pid }: { pid: number }) => {
          treeOrders.push(pid)
          return true
        },
      } as never),
    )
    steered({})

    // «Перебить сейчас» и «Отменить» ходят одной дверью — реестром ходов.
    expect(registry.stop('BL-1')).toBe(true)
    expect(treeOrders).toEqual([4242])
    // И ОДИНОЧНОГО ПРИКАЗА НЕТ ВОВСЕ: убитый первым родитель оставил бы помощника сиротой,
    // которого уже не с чего найти — это и есть измеренный сирота на 193 секунды.
    expect(killed).toEqual([])
  })

  it('приказ дереву не отдан — гасим ребёнка ровно как раньше: отмена не перестаёт работать', () => {
    const killed: string[] = []
    const h = spawnWorker({
      bin: 'codex',
      args: [],
      cwd: '/tmp/копия',
      env: {},
      spawnImpl: () => fakeChild(4242, killed),
      killTreeImpl: () => false,
    } as never)
    h.kill()
    expect(killed).toEqual(['одиночный pid'])
  })

  it('на Windows приказ — «этот и всё, что он породил»; на других системах он честно не отдаётся', () => {
    const calls: { bin: string; args: string[] }[] = []
    const execFileImpl = (bin: string, args: string[]) => {
      calls.push({ bin, args })
    }

    expect(killProcessTree({ pid: 777, platform: 'win32', execFileImpl })).toBe(true)
    expect(calls[0].bin).toBe('taskkill')
    expect(calls[0].args).toEqual(['/pid', '777', '/t', '/f'])

    // Дерева здесь не снять — и обещания об этом нет: вызывающий гасит одиночный процесс.
    expect(killProcessTree({ pid: 777, platform: 'linux', execFileImpl })).toBe(false)
    // Ребёнка, которого не было, тоже не гасят.
    expect(killProcessTree({ pid: undefined, platform: 'win32', execFileImpl })).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

// ═══════════ (3) ВРЕМЯ ДО ПЕРВОГО СЛОВА — НА ДОЛГОВЕЧНОЙ СТРОКЕ, СЛОВАМИ ═══════════════════

describe('строка попытки говорит, сколько сессия собиралась, прежде чем заговорить', () => {
  it('минуты молчания перед первым кадром стоят на строке НА ДИСКЕ — числом и фразой', async () => {
    const { row } = await runTick({ firstFrameAfterMs: 254_000 })

    expect(row.sessionStart).toBeTruthy()
    expect(row.sessionStart.ms).toBe(254_000)
    // СЛОВАМИ — чтобы «молчит N минут» отличалось от «ещё готовит песочницу».
    expect(row.sessionStart.words).toContain('4 мин 14 с')
    expect(row.sessionStart.words).toContain('первого слова')
  })

  it('быстрый старт читается как быстрый: то же поле, другой ответ', async () => {
    const { row } = await runTick({ firstFrameAfterMs: 2_000 })
    expect(row.sessionStart.ms).toBe(2_000)
    expect(row.sessionStart.words).toContain('2 с')
  })

  it('кадра не было вовсе — это сказано вслух, а не записано нулём', () => {
    const silent = sessionStartRecord({ spawnedAt: 1_000, firstLineAt: null })
    expect(silent.ms).toBeNull()
    expect(silent.words).toContain('не подала голоса')
  })

  // ЗАПИСАНО — НЕ ТО ЖЕ САМОЕ, ЧТО ПРЕДЪЯВЛЕНО. Поле, лежащее на строке и не названное дверью
  // карточки, видит только тот, кто откроет файл реестра, — то есть никто из тех, ради кого
  // оно заводилось.
  it('дверь карточки НАЗЫВАЕТ это время — и молчит нулём, когда попытка о нём молчит', async () => {
    const CARD_TOKEN = 'tkn-session-start'
    const mkReq = (url: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = Readable.from([])
      req.method = 'GET'
      req.url = url
      req.headers = { authorization: `Bearer ${CARD_TOKEN}` }
      req.socket = { remoteAddress: '10.0.0.9' }
      return req
    }
    const mkRes = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = {
        statusCode: 0,
        body: '',
        headersSent: false,
        writeHead(code: number) {
          res.statusCode = code
          res.headersSent = true
          return res
        },
        end(c?: unknown) {
          if (c != null) res.body += String(c)
          return res
        },
      }
      return res
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cardOf = async (attempts: any[]) => {
      const projectDir = mkDir('sma-sessionstart-card-')
      const front = createFrontServer({
        config: { token: CARD_TOKEN, repoDir: projectDir },
        deps: {
          repoDir: projectDir,
          clock: () => 1_770_000_000_000,
          adapter: {
            list: async () => [{ id: 'BL-7', status: 'awaiting_approval', lane: 'prod', title: 'дело', attempt: 1, priority: 0 }],
          },
          ledger: {
            readAttempts: () => attempts,
            readAttemptLog: () => ({ entries: [], truncated: false, roles: [], rolesMore: 0, digest: null }),
            readJournalEntries: () => [],
          },
        },
      })
      const res = mkRes()
      await front.handle(mkReq('/api/task/BL-7'), res)
      return JSON.parse(res.body)
    }

    const said = { ms: 254_000, words: 'от запуска до первого слова сессии — 4 мин 14 с' }
    const shown = await cardOf([{ attempt: 1, outcome: 'completed', workerId: 'pro-1', sessionStart: said }])
    expect(shown.attempts[0].sessionStart).toEqual(said)

    const silent = await cardOf([{ attempt: 1, outcome: 'completed', workerId: 'pro-1' }])
    // `null` — «попытка об этом молчит», и это не «стартовала мгновенно».
    expect(silent.attempts[0].sessionStart).toBeNull()
  })
})

// ═══════════ (4) ТУМБЛЕР ЧИТАЕТСЯ В МОМЕНТ ЗАПУСКА ════════════════════════════════════════

describe('работник, выключенный пока попытка готовилась, до процесса не доходит', () => {
  it('тумблер сняли внутри подготовки копии — НИ ОДНОГО процесса, названная причина на карточке', async () => {
    const { res, row, spawned, logged } = await runTick({
      duringProvisioning: ({ worker }) => {
        worker.enabled = false // рука человека в окне, ровно в ту паузу
      },
    })

    expect(spawned).toHaveLength(0) // это и есть «не спавн выключенным работником»
    expect(res.failed).toMatchObject({ taskId: 'BL-1', reason: 'worker_switched_off' })
    expect(row.failureReason).toBe('worker_switched_off')
    // ПРИЧИНА СКАЗАНА СЛОВАМИ, а не только кодом: человек читает карточку, а не таксономию.
    expect(REASON_LABELS.worker_switched_off).toContain('выключили')
    const refusal = logged.find((e) => e.type === 'task.refused')
    expect(String(refusal?.detail)).toContain('pro-1')
  })

  it('работа возвращается в очередь, а не паркуется: остальной состав цел', async () => {
    await runTick({
      duringProvisioning: ({ worker }) => {
        worker.enabled = false
      },
    })
    // Отдельно от role_unavailable, который ждёт человека: там роли не держит никто.
    expect(failureAwaitsAPerson('worker_switched_off')).toBe(false)
    expect(failureAwaitsAPerson('role_unavailable')).toBe(true)
  })

  it('включённый работник проходит ровно как раньше — без второй половины отказ был бы выключенной полосой', async () => {
    const { res, spawned } = await runTick()
    expect(spawned).toHaveLength(1)
    expect(res.failed).toBeFalsy()
  })

  it('состав читается В МОМЕНТ ВОПРОСА, а не с сохранённой ссылки на прошлый список', () => {
    const worker = { id: 'pro-1', enabled: true }
    const deps = { config: { workers: [worker] } }
    const route = { workerId: 'pro-1' }
    expect(workerSwitchedOffNow(deps, route)).toBeNull()

    // Дверь тумблера подменяет СПИСОК целиком — тот, кто снял его раньше, держит прошлое.
    deps.config.workers = [{ id: 'pro-1', enabled: false }]
    expect(workerSwitchedOffNow(deps, route)?.reason).toBe('worker_switched_off')

    // Работника убрали из состава совсем — это другое движение руки, и слова другие.
    deps.config.workers = []
    expect(workerSwitchedOffNow(deps, route)?.detail).toContain('убрали из состава')

    // У платного канала тумблера нет — выдумывать ему отказ нечем.
    expect(workerSwitchedOffNow(deps, { workerId: null })).toBeNull()
  })
})
