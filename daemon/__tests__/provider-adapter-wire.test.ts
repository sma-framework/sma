/**
 * ПОЛОСА ЛЮБОГО ПОСТАВЩИКА ЖИВЁТ НА ОДНОМ ФУНДАМЕНТЕ — ПРОВОД ОТ ТАБЛИЦЫ ПОЛОС ДО ПРОДУКТА.
 *
 * ═══════════════ ЧТО СТОРОЖИТ ЭТОТ ФАЙЛ ═══════════════
 *
 * Полоса — это НЕ россыпь сравнений имени по дереву. Она объявлена одной строкой таблицы
 * (`runner/provider-adapter.mjs`): чем запускается, во что превращается конверт, читает ли
 * поставщик свои окна, можно ли вернуться в ту же сессию, каким кадром кончается поток и как с
 * этого кадра снимаются числа. Всё остальное дерево обязано СПРАШИВАТЬ таблицу, а не угадывать
 * поставщика по имени двоичного файла.
 *
 * ЧЕТЫРЕ УТВЕРЖДЕНИЯ, И НИ ОДНО ИЗ НИХ — ПРО ФАЙЛЫ ЭТОЙ ЖЕ РАБОТЫ:
 *
 *   (1) ОЧЕРЕДЬ И ЗАПУСК ГОВОРЯТ ОБ ОДНИХ И ТЕХ ЖЕ ПОЛОСАХ: каждая полоса, которую очередь
 *       принимает у задачи как исполнителя, названа в таблице. Добавленная в одном месте и
 *       забытая в другом полоса — это задача, которую примут и не смогут запустить.
 *   (2) СПАВН БЕРЁТ ДВОИЧНЫЙ ФАЙЛ И ПЕСОЧНИЦУ ИЗ ТАБЛИЦЫ: настоящий сборщик команды на обеих
 *       полосах отдаёт ровно то, что таблица о них говорит, — включая границу, в которую
 *       переводится грант конверта.
 *   (3) УЧЁТ ЧИТАЕТ ФИНАЛЬНЫЙ КАДР ТОЙ ПОЛОСЫ, КОТОРАЯ ПРАВДА ШЛА: настоящий тик книгует
 *       строку расхода с источником своего поставщика — на обеих полосах.
 *   (4) ДОРОГА ПОПРАВКИ ВЫБИРАЕТСЯ ПО ПОЛОСЕ, А НЕ ПО ИМЕНИ ФАЙЛА. Полоса Claude, поставленная
 *       на машине как npm-обёртка, запускается как `node <скрипт>` — и решение «доставить
 *       слово возобновлением сессии» бралось из сравнения `spec.bin` с именем `claude`. На
 *       такой машине оно молча уезжало в дорогу чужой полосы: слово приклеивалось к заданию,
 *       живая сессия не возобновлялась вовсе. Спрашивается полоса, а не файл.
 *
 * Тик настоящий, очередь настоящая, реестр настоящий, сборщик команды настоящий; подделаны
 * только процесс работника и стоки.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue, TASK_PROVIDERS } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { appendRedirect, correctionsPreamble } from '../src/runner/redirects.mjs'
import { createBuildArgs } from '../src/runner/build-args.mjs'
import { buildClaudeArgs } from '../src/runner/args.mjs'
import { PROVIDER_ADAPTERS, providerAdapter, laneAdapter } from '../src/runner/provider-adapter.mjs'

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

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

// ═══════════ (1) ОЧЕРЕДЬ И ЗАПУСК ГОВОРЯТ ОБ ОДНИХ И ТЕХ ЖЕ ПОЛОСАХ ════════════════════════

describe('таблица полос — один список на очередь и на запуск', () => {
  it('каждая полоса, которую очередь принимает как исполнителя, названа в таблице', () => {
    for (const provider of TASK_PROVIDERS) {
      // `api` — это ПЛАТНЫЙ КАНАЛ, а не полоса: у него нет ни работника, ни командной строки,
      // и маршрут по нему не спавнит ничего. Он и не должен быть в таблице запуска.
      if (provider === 'api') {
        expect(providerAdapter(provider)).toBeNull()
        continue
      }
      const lane = providerAdapter(provider)
      expect(lane, `полоса ${provider} принимается очередью, но не названа в таблице запуска`).not.toBeNull()
      expect(typeof lane.bin).toBe('string')
      expect(lane.bin.length).toBeGreaterThan(0)
    }
  })

  it('незнакомая полоса — это отсутствие строки, а не догадка; читатель по умолчанию честно назван', () => {
    expect(providerAdapter('нет-такой-полосы')).toBeNull()
    expect(providerAdapter(undefined)).toBeNull()
    // Читателям тика нужен ответ всегда: полоса, о которой таблица молчит, читается как
    // сегодняшняя дорога по умолчанию — и это ОБЪЯВЛЕНО, а не спрятано в `if` у потребителя.
    expect(laneAdapter('нет-такой-полосы')).toBe(PROVIDER_ADAPTERS.claude)
    expect(laneAdapter('codex')).toBe(PROVIDER_ADAPTERS.codex)
  })
})

// ═══════════ (2) СПАВН БЕРЁТ ДВОИЧНЫЙ ФАЙЛ И ПЕСОЧНИЦУ ИЗ ТАБЛИЦЫ ══════════════════════════

const claudeWorker = {
  id: 'max-1',
  lane: 'prod',
  provider: 'claude',
  enabled: true,
  account: { name: 'max-1', configDir: '/accounts/max-1', oauthTokenEnv: 'SMA_MAX_1_TOKEN' },
}

const MIRRORED_SETTINGS = JSON.stringify({ disableClaudeAiConnectors: true })

const buildTask = (over: Record<string, unknown> = {}) => ({
  id: 'T-9001',
  title: 'задача полосы',
  note: 'подробности',
  lane: 'prod',
  ...over,
})

describe('сборка команды спрашивает таблицу, а не ветвится по имени', () => {
  it('полоса Claude запускается тем двоичным файлом, который назвала таблица', () => {
    const build = createBuildArgs({
      config: { workers: [claudeWorker] },
      env: { SMA_MAX_1_TOKEN: 'token' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fsImpl: { readFileSync: (p: string) => (String(p).endsWith('settings.json') ? MIRRORED_SETTINGS : (() => { throw new Error('ENOENT') })()) } as any,
      platform: 'linux',
    })
    const spec = build(buildTask(), { workerId: 'max-1', provider: 'claude', useApiFallback: false })
    expect(spec.provider).toBe('claude')
    expect(spec.bin).toBe(providerAdapter('claude').bin)
  })

  it('полоса codex запускается своим файлом, и на командной строке стоит та песочница, которую назвала таблица', () => {
    const root = mkDir('sma-lane-codex-')
    const accountDir = join(root, 'pro-1')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(join(accountDir, 'auth.json'), '{"tokens":{"id_token":"subscription"}}')

    const codexWorker = {
      id: 'pro-1',
      lane: 'prod',
      provider: 'codex',
      enabled: true,
      account: { name: 'pro-1', configDir: accountDir },
    }
    const build = createBuildArgs({
      config: { workers: [codexWorker] },
      env: { HOME: join(root, 'empty'), USERPROFILE: join(root, 'empty') },
      fsImpl: {
        readFileSync: (p: string, enc: string) =>
          String(p).replace(/\\/g, '/').endsWith('settings.json') ? MIRRORED_SETTINGS : readFileSync(p, enc as never),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      platform: 'linux',
    })

    const allowedTools = ['Read', 'Edit', 'Write', 'Bash']
    const spec = build(buildTask(), { workerId: 'pro-1', provider: 'codex', useApiFallback: false }, { allowedTools })

    expect(spec.provider).toBe('codex')
    expect(spec.bin).toBe(providerAdapter('codex').bin)
    // ГРАНИЦА КОНВЕРТА ЧИТАЕТСЯ ОДНИМ ВЫРАЖЕНИЕМ: то, что таблица говорит о гранте, стоит на
    // командной строке. Два прочтения одного конверта — это отказ по одному, а запуск по другому.
    const sandbox = providerAdapter('codex').sandboxOf(allowedTools)
    expect(sandbox).toBe('workspace-write')
    expect(spec.args[spec.args.indexOf('--sandbox') + 1]).toBe(sandbox)
  })
})

// ═══════════ ОБСТАНОВКА ТИКА ═══════════════════════════════════════════════════════════════

const NOTE = 'APPROACH_NOTE: прямой путь'
const LESSON = 'LESSON_NONE: задача была чистым чтением'
const SESSION_ID = '3f2b1a0c-0000-4000-8000-abcdefabcdef'

const CLAUDE_INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID })
const CLAUDE_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.42,
  session_id: SESSION_ID,
  modelUsage: { 'claude-opus-5': { inputTokens: 1234, outputTokens: 567, cacheReadInputTokens: 89, cacheCreationInputTokens: 12 } },
})
const CODEX_FINAL = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 4321, output_tokens: 765, cached_input_tokens: 98 },
})

const makeVerbRunner = (responses: Record<string, unknown>) => async (_bin: string, argsArray: string[]) => {
  const verb = argsArray[1]
  const r = (responses as Record<string, unknown>)[verb] ?? { code: 0, stdout: '{}' }
  return typeof r === 'function' ? (r as () => unknown)() : r
}

const gateGit = (args: string[]) => {
  const verb = args[0]
  if (verb === 'rev-parse') return 'base0000'
  if (verb === 'rev-list') return '1'
  if (verb === 'diff') return 'M\tdaemon/src/loop.mjs'
  return ''
}

const GREEN_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }) }

type SpawnSeen = { bin: string; args: string[]; prompt: string }

/**
 * Один настоящий тик. Полоса задаётся ПОЛЕМ ЗАДАЧИ (`provider`), поэтому маршрут выбирает
 * работника настоящим правилом маршрутизации, а не подставленным ответом.
 */
async function runTick(opts: {
  provider: 'claude' | 'codex'
  lines: string[]
  spec?: (base: Record<string, unknown>) => Record<string, unknown>
  redirect?: string
}) {
  const projectDir = mkDir('sma-lane-proj-')
  const ledgerDir = mkDir('sma-lane-ledger-')
  const workDir = mkDir('sma-lane-copy-')
  const dataDir = mkDir('sma-lane-data-')
  writeFileSync(join(workDir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')

  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue({
    id: 'BL-9',
    source: 'backlog',
    title: 'одна и та же работа на обеих полосах',
    lane: 'prod',
    priority: 0,
    storyPoints: 3,
    provider: opts.provider,
    acceptance: 'зелёные узкие тесты и квитанция',
  })
  if (opts.redirect) {
    appendRedirect({ dataDir, taskId: 'BL-9', text: opts.redirect, mode: 'interrupt', clock: c.clock })
  }

  const booked: Record<string, unknown>[] = []
  const logged: Record<string, unknown>[] = []
  const spawns: SpawnSeen[] = []

  const workers = [
    { id: 'max-1', lane: 'prod', provider: 'claude', account: { name: 'local-1', configDir: '/x' }, enabled: true },
    { id: 'pro-1', lane: 'prod', provider: 'codex', account: { name: 'codex-1', configDir: '/y' }, enabled: true },
  ]

  const baseSpec = {
    bin: laneAdapter(opts.provider).bin,
    args: buildClaudeArgs({}),
    env: { PATH: '/usr/bin' },
    prompt: 'сделай дело и оставь квитанцию',
    provider: opts.provider,
    workerId: opts.provider === 'codex' ? 'pro-1' : 'max-1',
  }

  const deps: Record<string, unknown> = {
    adapter,
    ledger: {
      recordAttempt: (row: unknown) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: { attemptId: string }) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config: { workers, agingHours: 24, backlogScanMinutes: 60, repoDir: projectDir, dataDir, pipeline: { enabled: true } },
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    // Полосу песочницы codex на этой машине не спрашиваем: она проверяется своим сьютом, а
    // здесь предмет — таблица полос. Платформа названа явно, чтобы ход был один на всех машинах.
    platform: 'linux',
    buildArgs: () => (opts.spec ? opts.spec({ ...baseSpec }) : { ...baseSpec }),
    verbRunner: makeVerbRunner({
      preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
      worktree: {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          path: workDir,
          branch: 'wt/BL-9',
          materialized: [{ path: 'CLAUDE.md', mode: 'copy', files: 1, tracked: 0, current: 0, bytes: 812 }],
        }),
      },
      reverify: GREEN_REVERIFY,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnWorker: (spec: any) => {
      spawns.push({ bin: String(spec.bin), args: [...(spec.args ?? [])], prompt: String(spec.prompt ?? '') })
      for (const l of opts.lines) spec.onLine?.(l)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    bookUsage: (row: Record<string, unknown>) => booked.push(row),
    report: async () => {},
    clock: c.clock,
    journal: (row: Record<string, unknown>) => logged.push(row),
    execGit: gateGit,
  }

  const res = await tick(deps)
  return { res, booked, logged, spawns, dataDir, projectDir }
}

// ═══════════ (3) УЧЁТ ЧИТАЕТ ФИНАЛЬНЫЙ КАДР СВОЕЙ ПОЛОСЫ ══════════════════════════════════

describe('расход книгуется читателем той полосы, которая правда шла', () => {
  it('полоса Claude: строка книги снята с её финального кадра', async () => {
    const { booked } = await runTick({ provider: 'claude', lines: [CLAUDE_INIT, CLAUDE_RESULT, NOTE, LESSON] })
    const row = booked.find((r) => r.taskId === 'BL-9')
    expect(row).toBeTruthy()
    expect(row!.provider).toBe('claude')
    expect(row!.source).toBe('stream-result')
    expect(row!.inputTokens).toBe(1234)
  })

  it('полоса codex: строка книги снята с ЕЁ финального кадра, а не прочитана чужим читателем', async () => {
    const { booked } = await runTick({ provider: 'codex', lines: [CODEX_FINAL, NOTE, LESSON] })
    const row = booked.find((r) => r.taskId === 'BL-9')
    expect(row).toBeTruthy()
    expect(row!.provider).toBe('codex')
    expect(row!.source).toBe('codex-final')
    expect(row!.inputTokens).toBe(4321)
  })
})

// ═══════════ (4) ДОРОГА ПОПРАВКИ — ПО ПОЛОСЕ, А НЕ ПО ИМЕНИ ФАЙЛА ═════════════════════════

describe('поправка едет дорогой, которую назвала полоса', () => {
  const WORD = 'не трогай квитанции, поправь только заголовок'

  it('полоса Claude, поставленная npm-обёрткой (запуск через node), возвращается в ту же сессию', async () => {
    // ЭТО НЕ ВЫДУМАННАЯ ФОРМА. Именно так сборщик команды отдаёт спавн на машине, где CLI
    // установлен через npm: двоичный файл — интерпретатор, а имя CLI лежит в аргументах.
    const { spawns, logged } = await runTick({
      provider: 'claude',
      lines: [CLAUDE_INIT, CLAUDE_RESULT, NOTE, LESSON],
      redirect: WORD,
      spec: (base) => ({ ...base, bin: '/usr/bin/node', args: ['/pkg/claude/cli.js', ...(base.args as string[])] }),
    })

    // Слово НЕ приклеено к заданию первого запуска: у этой полосы есть живая дорога.
    expect(spawns[0].prompt).not.toContain(correctionsPreamble([{ text: WORD }]))
    // Сессия возобновлена — второй запуск той же командой плюс возврат в сессию.
    expect(spawns.length).toBeGreaterThanOrEqual(2)
    expect(spawns[1].args).toContain('--resume')
    expect(spawns[1].prompt).toContain(WORD)
    // И ни одной записи «полоса не умеет» — она умеет.
    expect(logged.filter((r) => r.type === 'task.redirect_skipped' && r.reason === 'provider')).toHaveLength(0)
  })

  it('полоса codex: живой дороги нет, слово едет заданием следующего запуска — и это записано', async () => {
    const { spawns, logged } = await runTick({
      provider: 'codex',
      lines: [CODEX_FINAL, NOTE, LESSON],
      redirect: WORD,
    })

    expect(spawns).toHaveLength(1)
    expect(spawns[0].prompt).toContain(WORD)
    const said = logged.filter((r) => r.type === 'task.redirected')
    expect(said.some((r) => r.delivery === 'prompt')).toBe(true)
  })
})
