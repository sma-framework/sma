/**
 * ПЕСОЧНИЦА ПОЛОСЫ CODEX — ПРОВОД ОТ КОНВЕРТА ДО СТРОКИ, КОТОРУЮ ЧИТАЕТ ЧЕЛОВЕК.
 *
 * ЧТО СЛУЧИЛОСЬ ЖИВЬЁМ 01.09.2026, И ПОЧЕМУ ЭТОТ ФАЙЛ ВЫГЛЯДИТ ИМЕННО ТАК. Задача на полосе
 * prod ушла к codex-исполнителю с конвертом, несущим Edit/Write/Bash. Провод конверта был цел:
 * `envelopeSpawnOptions` в сборке спавна есть, `codexSandboxFor` вернул `workspace-write`, флаг
 * встал на командную строку. А сессия ответила «writing is blocked by read-only sandbox» и не
 * смогла запустить даже `rg`: на Windows песочницу держит отдельно заведённый ограниченный
 * пользователь, и в СВЕЖЕМ доме задачи следа элевированной установки нет и быть не может.
 * Десять минут подписки, ноль файлов, ноль коммитов — и ни одной строки нигде, по которой
 * причину можно было бы назвать после того, как копию выметут.
 *
 * ЧЕТЫРЕ УТВЕРЖДЕНИЯ, И НИ ОДНО ИЗ НИХ — ПРО ФАЙЛЫ ЭТОЙ ЖЕ РАБОТЫ:
 *
 *   (1) строка попытки НА ДИСКЕ несёт полную команду спавна и песочницу, ПРОЧИТАННУЮ с неё;
 *   (2) задача с правом писать, отданная на непровизированную машину, ОТКАЗАНА ДО СПАВНА —
 *       процесса не существует вовсе, а на карточке стоит названная причина;
 *   (3) та же задача на провизированной машине запускается ровно как раньше. Пара (2)+(3) и
 *       есть требование «либо может писать, либо отказана до спавна»: без второй половины
 *       отказ был бы просто выключенной полосой;
 *   (4) записка и урок работника, названные СЛОВАМИ В ПОТОК, доезжают до гейта с полосы
 *       codex — единственная дорога объяснения, которая не требует записи на диск.
 *
 * Тик настоящий, git настоящий, леджер читается настоящим читателем с диска. Платформа и дом
 * инжектируются, поэтому ветка Windows гоняется на любой машине.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import { buildCodexArgs, codexHomeFor, CODEX_WINDOWS_SANDBOX_MARKER } from '../src/runner/args.mjs'

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
  const dir = mkDir('sma-codexbox-copy-')
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

// ── поток полосы codex: слова работника ЖИВУТ ВНУТРИ КАДРА ─────────────────────────────────
//
// Форма кадра — та же, что у фикстуры `codex-stream.ndjson` этого сьюта и у живого
// `codex exec --json`: ни `message.content`, ни `result` в нём не бывает никогда.
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
  title: 'работа с правкой на полосе codex',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
  ...over,
})

const makeVerbRunner = (responses: Record<string, unknown>) => async (_bin: string, argsArray: string[]) => {
  const verb = argsArray[1]
  const r = (responses as Record<string, never>)[verb] ?? { code: 0, stdout: '{}' }
  return typeof r === 'function' ? (r as () => unknown)() : r
}

const GREEN_REVERIFY = { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+1 -0' }) }

/**
 * Один настоящий тик по полосе codex.
 *
 * `provisioned` — проведена ли на этой машине элевированная установка песочницы ДЛЯ ДОМА ЭТОЙ
 * ЗАДАЧИ: файл кладётся по тому же выражению пути, каким его найдёт демон (`codexHomeFor`),
 * а не по строке, собранной здесь руками, — иначе сьют проверял бы не тот каталог.
 */
async function runTick(over: {
  provisioned?: boolean
  platform?: string
  lines?: string[]
  sandbox?: string
} = {}) {
  const accountDir = mkDir('sma-codexbox-acct-')
  const projectDir = mkDir('sma-codexbox-proj-')
  const ledgerDir = mkDir('sma-codexbox-ledger-')
  const copy = makeCopy()
  const workDir = copy.dir
  const worker = { ...CODEX_WORKER, account: { ...CODEX_WORKER.account, configDir: accountDir, spendLogsDir: join(accountDir, 'spend') } }

  const home = codexHomeFor({ account: worker.account, taskId: 'BL-1' })
  if (over.provisioned) {
    mkdirSync(join(home, '.sandbox'), { recursive: true })
    writeFileSync(join(home, CODEX_WINDOWS_SANDBOX_MARKER), '{"version":5}', 'utf8')
  }

  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue(backlogTask())
  const logged: Record<string, unknown>[] = []
  const spawned: Record<string, unknown>[] = []
  const lines = over.lines ?? [codexSaid(`${NOTE}\n${LESSON}`)]

  const deps: Record<string, unknown> = {
    adapter,
    ledger: {
      recordAttempt: (row: unknown) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: { attemptId: string }) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config: {
      workers: [worker],
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: projectDir,
      pipeline: { enabled: true },
      // ПОЛОСА prod, ВЕДУЩАЯ В CODEX — ровно та расстановка, на которой сломалось живьём.
      // По умолчанию prod ведёт в claude; маршрут полосы — настройка человека, и здесь он
      // объявлен явно, чтобы случай был о песочнице, а не о том, кому досталась работа.
      laneRouting: { prod: { provider: 'codex' } },
    },
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    // ПЛАТФОРМА И ДОМ — ШВЫ. Ветка Windows должна гоняться на машине разработчика тоже:
    // «проверено только там, где и так ломалось» — это не проверка.
    platform: over.platform ?? 'win32',
    // Команда спавна — настоящая, собранная тем же строителем, что и в бою: строка реестра
    // обязана нести ТО, ЧЕМ ЗАПУСКАЛИ, а не то, что удобно утверждать.
    buildArgs: () => ({
      bin: 'codex',
      args: buildCodexArgs({ sandbox: over.sandbox ?? 'workspace-write' }),
      env: { CODEX_HOME: home, PATH: '/usr/bin' },
      prompt: 'сделай дело',
      workerId: worker.id,
      provider: 'codex',
    }),
    verbRunner: makeVerbRunner({
      preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
      worktree: {
        code: 0,
        stdout: JSON.stringify({ ok: true, path: workDir, branch: 'wt/BL-1', expectedBase: copy.base, materialized: [] }),
      },
      reverify: GREEN_REVERIFY,
    }),
    spawnWorker: (spec: Record<string, unknown>) => {
      spawned.push(spec)
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
  return { res, row: rows[rows.length - 1], logged, spawned, home, ledgerDir }
}

// ═══════════ (1) ЧЕМ ЗАПУСТИЛИ — НА ДОЛГОВЕЧНОЙ СТРОКЕ ═════════════════════════════════════

describe('строка попытки несёт команду спавна и ту песочницу, что правда была', () => {
  it('провизированная машина: строка НА ДИСКЕ несёт bin, полный argv и sandbox с этого же argv', async () => {
    const { res, row, spawned } = await runTick({ provisioned: true })

    expect(spawned).toHaveLength(1) // процесс был — значит и команда была
    expect(res.failed).toBeFalsy()
    expect(row.spawn.bin).toBe('codex')
    expect(row.spawn.args).toContain('--sandbox')
    expect(row.spawn.args).toEqual(spawned[0].args)
    // ПЕСОЧНИЦА ПРОЧИТАНА С КОМАНДНОЙ СТРОКИ, А НЕ ПОСЧИТАНА ЗАНОВО: ровно эта разница и
    // стоила окна подписки — по всем утверждениям право писать было, а сессия была читающей.
    expect(row.spawn.sandbox).toBe('workspace-write')
  })

  it('читающая полоса: на строке стоит read-only — то же чтение, другой ответ', async () => {
    const { row } = await runTick({ provisioned: true, sandbox: 'read-only' })
    expect(row.spawn.sandbox).toBe('read-only')
  })

  it('отказ до спавна: ключа команды на строке НЕТ — отсутствие говорит «процесса не было»', async () => {
    const { row, spawned } = await runTick({ provisioned: false })
    expect(spawned).toHaveLength(0)
    expect(row.spawn).toBeUndefined()
  })
})

// ═══════════ (2)+(3) ЛИБО МОЖЕТ ПИСАТЬ, ЛИБО ОТКАЗАНА ДО СПАВНА ════════════════════════════

describe('задача с правом писать на полосе codex: либо пишет, либо отказана словами', () => {
  it('непровизированная Windows: НИ ОДНОГО процесса, названная причина и слова на карточке', async () => {
    const { res, row, spawned, logged, home } = await runTick({ provisioned: false })

    expect(spawned).toHaveLength(0) // это и есть «не спавн в стену»
    expect(res.failed).toMatchObject({ taskId: 'BL-1', reason: 'missing_access' })
    expect(row.outcome).toBe('failed')
    expect(row.failureReason).toBe('missing_access')
    // СЛОВАМИ, А НЕ КОДОМ ДВЕРИ: человек должен прочитать, ЧТО именно не исполнится и где.
    expect(row.failureDetail).toContain('workspace-write')
    expect(row.failureDetail).toContain(home)
    expect(row.failureDetail).toContain('codex sandbox setup')
    // …и то же самое в журнале оператора, до всякой копии.
    expect(logged.some((e) => e.type === 'task.refused' && String(e.detail).includes('workspace-write'))).toBe(true)
  })

  it('провизированная Windows: та же задача запускается — отказ не превратился в выключенную полосу', async () => {
    const { res, spawned } = await runTick({ provisioned: true })
    expect(spawned).toHaveLength(1)
    expect(res.failed).toBeFalsy()
  })

  it('не-Windows: песочницу держит ядро, готовить нечего — запуск как раньше', async () => {
    const { spawned } = await runTick({ provisioned: false, platform: 'linux' })
    expect(spawned).toHaveLength(1)
  })
})

// ═══════════ (4) ЗАПИСКА, КОТОРАЯ НЕ ТРЕБУЕТ ЗАПИСИ НА ДИСК ════════════════════════════════

describe('слова работника с полосы codex доезжают до гейта', () => {
  it('записка и урок внутри кадра codex приняты — попытка закрывается зелёной', async () => {
    const { res } = await runTick({ provisioned: true })
    expect(res.completed).toBe('BL-1')
  })

  it('тот же прогон без маркеров — «не объяснился»: утверждение проверяет гейт, а не парсер', async () => {
    const { res } = await runTick({
      provisioned: true,
      lines: [codexSaid('сделал работу и молча ушёл')],
    })
    expect(res.completed).toBeUndefined()
    expect(res.failed).toMatchObject({ taskId: 'BL-1' })
  })
})
