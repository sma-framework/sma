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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter } from '../src/queue/attempt-ledger.mjs'
import {
  buildCodexArgs,
  codexConfigSeed,
  codexHomeFor,
  CODEX_WINDOWS_SANDBOX_MARKER,
  CODEX_SANDBOX_ARTIFACTS,
} from '../src/runner/args.mjs'

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

/**
 * Копия работника ТАК, КАК ЕЁ ЧЕКАНИТ ДЕМОН: не отдельный репозиторий, а РАБОЧЕЕ ДЕРЕВО git.
 *
 * Разница между этим и `makeCopy()` — та самая, что стоила попытки 01.09.2026: у рабочего
 * дерева `.git` не каталог, а файл-указатель, и индекс, ссылки и объекты лежат в основном
 * репозитории, СНАРУЖИ рабочего каталога. Песочница `workspace-write` открывает на запись
 * рабочий каталог и ничего больше — то есть правку сделать можно, а сдать её нельзя.
 */
const makeWorktreeCopy = ({ work = true, branch = 'wt/BL-1', name = 'wt-BL-1' } = {}) => {
  const root = mkDir('sma-codexbox-main-')
  const main = join(root, 'main')
  mkdirSync(main, { recursive: true })
  git(['init', '-q', '.'], main)
  git(['config', 'user.email', 'wire@test'], main)
  git(['config', 'user.name', 'wire'], main)
  git(['config', 'core.autocrlf', 'false'], main)
  writeFileSync(join(main, 'CLAUDE.md'), '# правила проекта\n', 'utf8')
  // `docs/` есть в основании НАМЕРЕННО: иначе работа, положившая туда файл, упёрлась бы в
  // отдельный вопрос гейта — «работа завела каталог верхнего уровня, которого в дереве не
  // было», — и случай был бы не о песочнице, а об устройстве дерева.
  mkdirSync(join(main, 'docs'), { recursive: true })
  writeFileSync(join(main, 'docs', 'README.md'), '# документация\n', 'utf8')
  git(['add', 'CLAUDE.md', 'docs/README.md'], main)
  git(['commit', '-qm', 'база'], main)
  const base = git(['rev-parse', 'HEAD'], main).trim()
  const dir = join(root, name)
  git(['worktree', 'add', '-q', '-b', branch, dir], main)
  if (work) {
    writeFileSync(join(dir, 'product.txt'), 'работа сделана\n', 'utf8')
    git(['add', 'product.txt'], dir)
    git(['commit', '-qm', 'работа'], dir)
  }
  // СВОЙ каталог этой копии — не общий: индекс и HEAD рабочего дерева лежат здесь.
  return { dir, base, gitDir: join(main, '.git'), ownGitDir: join(main, '.git', 'worktrees', name) }
}

/**
 * Один и тот же каталог, названный двумя способами, — это один каталог.
 *
 * `os.tmpdir()` на Windows отдаёт КОРОТКОЕ имя (`JUNISA~1`), а git отвечает длинным, и сравнение
 * строк объявило бы два имени одного каталога разными. Спрашивается файловая система, а не
 * текст: `realpath` — единственный способ сказать «это то же место».
 */
const samePlace = (p: unknown) => {
  const raw = String(p)
  try {
    return (realpathSync.native ?? realpathSync)(raw).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  } catch {
    return raw.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  }
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
 *
 * `accountProvisioned` — проведена ли она для ДОМА АККАУНТА, и проведена ЦЕЛИКОМ: три каталога
 * следа, которые оставляет установка. Это РАЗНЫЕ каталоги, и именно их разница стоила окна
 * подписки 01.09.2026: установка была проведена (аккаунтский дом её несёт), а сессия стояла в
 * свежем доме задачи. С тех пор след КОПИРУЕТСЯ в дом задачи посевом — поэтому полный след в
 * доме счёта означает «задача сможет писать», а не «дом задачи пуст».
 *
 * `accountPartial` — установка была, но след неполон (один маркер, без учётных данных
 * ограниченного пользователя). Посев кладёт целиком либо никак, поэтому это по-прежнему отказ —
 * и он обязан звучать иначе, чем «установки не было вовсе».
 */
async function runTick(over: {
  provisioned?: boolean
  accountProvisioned?: boolean
  accountPartial?: boolean
  platform?: string
  lines?: string[]
  sandbox?: string
  worktreeCopy?: boolean
  failGitDirs?: boolean
  failGitCommonDirOnly?: boolean
  emptyBranch?: boolean
  // Лежит ли в доме задачи журнал помощника песочницы — тот, что уходит вместе с домом.
  sandboxJournal?: boolean
  // Что сессия ОСТАВЛЯЕТ В КОПИИ НЕЗАКОММИЧЕННЫМ: ровно то, чем кончается попытка, которой
  // песочница запретила запись в индекс, — файлы на диске есть, коммита нет.
  sessionLeaves?: Record<string, string>
} = {}) {
  const accountDir = mkDir('sma-codexbox-acct-')
  const projectDir = mkDir('sma-codexbox-proj-')
  const ledgerDir = mkDir('sma-codexbox-ledger-')
  const copy = over.worktreeCopy ? makeWorktreeCopy({ work: !over.emptyBranch }) : makeCopy()
  const workDir = copy.dir
  const worker = { ...CODEX_WORKER, account: { ...CODEX_WORKER.account, configDir: accountDir, spendLogsDir: join(accountDir, 'spend') } }

  const home = codexHomeFor({ account: worker.account, taskId: 'BL-1' })
  if (over.provisioned) {
    mkdirSync(join(home, '.sandbox'), { recursive: true })
    writeFileSync(join(home, CODEX_WINDOWS_SANDBOX_MARKER), '{"version":5}', 'utf8')
  }
  if (over.sandboxJournal) {
    // Форма — та же, что у настоящего журнала помощника на этой машине: раздача прав, запрет на
    // подкаталог уже разрешённого корня, итог обхода и строка запуска команды.
    mkdirSync(join(home, '.sandbox'), { recursive: true })
    writeFileSync(
      join(home, '.sandbox', 'sandbox.2026-09-03.log'),
      [
        '[2026-09-03T03:59:01Z] granting write ACE to C:\\projects\\sma\\.git for sandbox group',
        '[2026-09-03T03:59:02Z] applied deny ACE to protect C:\\projects\\sma\\.git\\worktrees\\wt-1',
        '[2026-09-03T03:59:02Z] setup refresh: processed 3 write roots (read roots delegated); errors=[]',
        '[2026-09-03 05:59:03 codex.exe] START: git commit -m проба',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(join(home, '.sandbox', 'deny_read_acl_state.json'), '{"principals":{}}', 'utf8')
  }
  if (over.accountProvisioned) {
    // ВЕСЬ след, а не один маркер: ровно те три каталога, что оставляет элевированная установка,
    // и ровно их посев копирует в дом задачи.
    for (const entry of CODEX_SANDBOX_ARTIFACTS) mkdirSync(join(accountDir, entry), { recursive: true })
    writeFileSync(join(accountDir, CODEX_WINDOWS_SANDBOX_MARKER), '{"version":5}', 'utf8')
    writeFileSync(join(accountDir, '.sandbox-secrets', 'sandbox_users.json'), '{"version":1}', 'utf8')
  }
  if (over.accountPartial) {
    mkdirSync(join(accountDir, '.sandbox'), { recursive: true })
    writeFileSync(join(accountDir, CODEX_WINDOWS_SANDBOX_MARKER), '{"version":5}', 'utf8')
  }

  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue(backlogTask())
  const logged: Record<string, unknown>[] = []
  const spawned: Record<string, unknown>[] = []
  const builtWith: Record<string, unknown>[] = []
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
    buildArgs: (_t: unknown, _r: unknown, options: Record<string, unknown> = {}) => {
      builtWith.push(options)
      return {
        bin: 'codex',
        args: buildCodexArgs({ sandbox: over.sandbox ?? 'workspace-write' }),
        env: { CODEX_HOME: home, PATH: '/usr/bin' },
        prompt: 'сделай дело',
        workerId: worker.id,
        provider: 'codex',
      }
    },
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
      // СЕССИЯ ПИШЕТ ФАЙЛЫ И НЕ КОММИТИТ ИХ — то, чем кончилась живая проба: работник дошёл до
      // конца, а `git add` ответил отказом, потому что песочница закрыла служебный каталог git.
      for (const [rel, text] of Object.entries(over.sessionLeaves ?? {})) {
        const abs = join(workDir, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, text, 'utf8')
      }
      for (const l of lines) (spec.onLine as (l: string) => void)?.(l)
      ;(spec.onExit as (e: unknown) => void)?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    report: async () => {},
    clock: c.clock,
    journal: (e: Record<string, unknown>) => logged.push(e),
    execGit: (args: string[], opts: { cwd?: string } = {}) => {
      if (args[0] === 'rev-parse' && String(args[1]).startsWith('--git-')) {
        if (over.failGitDirs) throw new Error('git недоступен')
        if (over.failGitCommonDirOnly && args[1] === '--git-common-dir') throw new Error('git недоступен')
      }
      return git(args, opts.cwd || workDir)
    },
  }

  const res = await tick(deps)
  const rows = readAttempts(ledgerDir, 'BL-1')
  return { res, row: rows[rows.length - 1], logged, spawned, builtWith, home, accountDir, ledgerDir, copy, workDir }
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

  // ШОВ СТРАЖА И ПОСЕВА. Дома задачи в момент этой проверки НЕ СУЩЕСТВУЕТ — его чеканит и
  // засевает сборщик аргументов, уже после решения тика. Страж, спрашивавший «лежит ли след в
  // доме задачи», получал «нет» ВСЕГДА и отказывал ДО ТОГО, как посев успевал лечь: замерено
  // живой пробой записи 01.09.2026 после выпуска — в доме счёта лежал полный след, а ни одна
  // пишущая задача полосы codex не стартовала. Здесь дом задачи ПУСТ (`provisioned: false`), и
  // единственное, что отделяет его от права писать, — посев из дома счёта.
  it('дом счёта несёт весь след — задача СТАРТУЕТ: страж считает посев, который ляжет до спавна', async () => {
    const { res, spawned } = await runTick({ provisioned: false, accountProvisioned: true })

    expect(spawned).toHaveLength(1)
    expect(res.failed).toBeFalsy()
  })

  it('след дома счёта неполон — отказ остаётся: посев кладёт целиком либо никак', async () => {
    const { res, spawned } = await runTick({ provisioned: false, accountPartial: true })

    expect(spawned).toHaveLength(0)
    expect(res.failed).toMatchObject({ taskId: 'BL-1', reason: 'missing_access' })
  })

  it('не-Windows: песочницу держит ядро, готовить нечего — запуск как раньше', async () => {
    const { spawned } = await runTick({ provisioned: false, platform: 'linux' })
    expect(spawned).toHaveLength(1)
  })
})

// ═══════════ ОТКАЗ НАЗЫВАЕТ ИСПОЛНИМЫЙ ВЫХОД, А НЕ ТУПИК ═══════════════════════════════════
//
// ОТКАЗ БЕЗ ВЫХОДА, КОТОРЫМ МОЖНО ВОСПОЛЬЗОВАТЬСЯ, — ЭТО ПОЛОВИНА ОТКАЗА. Первая редакция этих
// слов звала «провести `codex sandbox setup --elevated` для этого дома» — для каталога, который
// демон чеканит НА КАЖДУЮ ЗАДАЧУ и выметает вместе с ней: до задачи его нет, после задачи его
// нет, провести для него установку заранее нельзя вообще никак.
//
// А НА ЭТОЙ МАШИНЕ ЭТО ЧИТАЛОСЬ БЫ ЕЩЁ И КАК ЛОЖНОЕ ОБВИНЕНИЕ. Замерено чтением диска
// 01.09.2026: в аккаунтском доме `.sma-accounts/codex-1/.sandbox/setup_marker.json` лежит —
// установка ПРОВЕДЕНА, — а в доме задачи `codex-tasks/B-1788253929094-1/.sandbox/` только лог.
// Человек, сделавший всё правильно, прочитал бы на карточке «вы этого не сделали».
describe('слова отказа: развилка названа, тупик не предлагается', () => {
  it('дом задачи чеканится на задачу — и отказ говорит это, а не зовёт провизировать одноразовый путь', async () => {
    const { row, accountDir } = await runTick({ provisioned: false })
    const detail = String(row.failureDetail)

    // ПРИЧИНА, ПО КОТОРОЙ СОВЕТ «ПРОВЕСТИ УСТАНОВКУ» ЗДЕСЬ НЕ РАБОТАЕТ, — В САМИХ СЛОВАХ.
    expect(detail).toMatch(/на каждую задачу/i)
    expect(detail).toContain('codex-tasks')
    // …и повтор попытки назван бесполезным ЯВНО: иначе карточка с `missing_access` читается
    // как «попробуй ещё раз», а попыток здесь сколько угодно и все одинаковые.
    expect(detail).toMatch(/ни повтор попытки/i)
    // ВЫХОДЫ, КОТОРЫЕ ПРАВДА ЕСТЬ СЕГОДНЯ.
    expect(detail).toContain('полосе Claude')
    expect(detail).toMatch(/читающие задачи/i)
    // …а выход, который ПРАВДА работает, назван командой целиком — и он про дом СЧЁТА, тот
    // единственный каталог, для которого установку можно провести заранее.
    expect(detail).toContain('--codex-home')
    expect(detail).toContain(accountDir)
  })

  it('установка проведена, но след неполон — отказ называет НЕДОСТАЮЩЕЕ, а не винит человека', async () => {
    const { row, accountDir } = await runTick({ provisioned: false, accountPartial: true })
    const detail = String(row.failureDetail)

    expect(detail).toContain(accountDir)
    expect(detail).toMatch(/провизирован/i)
    // ГЛАВНОЕ УТВЕРЖДЕНИЕ ЭТОГО СЛУЧАЯ: сказано, ЧЕГО не хватает и что чинить, — а не «дом не
    // провизирован» про человека, который установку проводил.
    expect(detail).toContain('.sandbox-secrets')
    expect(detail).toMatch(/целиком либо никак/i)
    expect(detail).not.toMatch(/установки не было вовсе/i)
  })

  it('установки нет нигде — те же слова говорят другое: её не проводили', async () => {
    const { row, accountDir } = await runTick({ provisioned: false })
    const detail = String(row.failureDetail)

    expect(detail).toContain(accountDir)
    expect(detail).toMatch(/установки не было вовсе/i)
    expect(detail).not.toMatch(/не наследует/i)
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

// ═══════════ ВТОРАЯ ДВЕРЬ СПАВНА: ПОЛОСА КУЗНИЦЫ ═══════════════════════════════════════════
//
// ПОЧЕМУ ЭТОТ РАЗДЕЛ ЕСТЬ. Спавн в этом файле живёт в ДВУХ местах: путь кода и путь кузницы.
// Забытая вторая дверь — мина, которую loop.mjs уже дважды разминировал задним числом (куда
// кладётся копия, что в ней материализуется), и здесь она была бы той же самой: полоса кузницы
// ПИШЕТ файл — черновик, — значит её конверт несёт Edit/Write/Bash, значит на codex она
// переводится в `workspace-write` и на непровизированной машине упирается в ровно ту стену,
// что стоила окна подписки. Кончилось бы это не «песочницей», а «черновик не закоммичен»: на
// карточке виноват работник.
//
// Маршрут кузницы по умолчанию ведёт в claude — здесь он объявлен в codex явно, потому что
// это настройка человека, и вопрос случая именно «что будет, если её так поставят».

const forgeTask = (over: Record<string, unknown> = {}) => ({
  id: 'F-1',
  source: 'roster',
  title: 'сделай агента, который парсит ленту по тегу',
  lane: 'forge',
  forge: { kind: 'agent', description: 'парсит ленту по тегу и пишет сводку' },
  ...over,
})

async function runForgeTick(
  over: {
    provisioned?: boolean
    platform?: string
    worktreeCopy?: boolean
    sessionLeaves?: Record<string, string>
  } = {},
) {
  const accountDir = mkDir('sma-codexforge-acct-')
  const projectDir = mkDir('sma-codexforge-proj-')
  const ledgerDir = mkDir('sma-codexforge-ledger-')
  const copy = over.worktreeCopy ? makeWorktreeCopy({ branch: 'wt/F-1', name: 'wt-F-1' }) : makeCopy()
  const workDir = copy.dir
  const worker = {
    id: 'creator',
    lane: 'forge',
    provider: 'codex',
    enabled: true,
    account: { name: 'creator', configDir: accountDir, spendLogsDir: join(accountDir, 'spend') },
  }

  const home = codexHomeFor({ account: worker.account, taskId: 'F-1' })
  if (over.provisioned) {
    mkdirSync(join(home, '.sandbox'), { recursive: true })
    writeFileSync(join(home, CODEX_WINDOWS_SANDBOX_MARKER), '{"version":5}', 'utf8')
  }

  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue(forgeTask())
  const logged: Record<string, unknown>[] = []
  const spawned: Record<string, unknown>[] = []
  const builtWith: Record<string, unknown>[] = []

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
      laneRouting: { forge: { provider: 'codex' } },
    },
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    platform: over.platform ?? 'win32',
    buildArgs: (_t: unknown, _r: unknown, options: Record<string, unknown> = {}) => {
      builtWith.push(options)
      return {
        bin: 'codex',
        args: buildCodexArgs({ sandbox: 'workspace-write' }),
        env: { CODEX_HOME: home, PATH: '/usr/bin' },
        prompt: 'ЗАМЕНИТСЯ подсказкой кузницы',
        workerId: worker.id,
        provider: 'codex',
      }
    },
    verbRunner: makeVerbRunner({
      worktree: {
        code: 0,
        stdout: JSON.stringify({ ok: true, path: workDir, branch: 'wt/F-1', expectedBase: copy.base, materialized: [] }),
      },
    }),
    spawnWorker: (spec: Record<string, unknown>) => {
      spawned.push(spec)
      for (const [rel, text] of Object.entries(over.sessionLeaves ?? {})) {
        const abs = join(workDir, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, text, 'utf8')
      }
      ;(spec.onLine as (l: string) => void)?.(codexSaid(NOTE))
      ;(spec.onExit as (e: unknown) => void)?.({ code: 0, signal: null })
      return { pid: 4243, kill: () => {} }
    },
    report: async () => {},
    clock: c.clock,
    journal: (e: Record<string, unknown>) => logged.push(e),
    execGit: (args: string[], opts: { cwd?: string } = {}) => git(args, opts.cwd || workDir),
  }

  const res = await tick(deps)
  const rows = readAttempts(ledgerDir, 'F-1')
  return { res, row: rows[rows.length - 1], logged, spawned, builtWith, home, copy, workDir }
}

describe('полоса кузницы на codex: та же граница, та же дверь', () => {
  it('непровизированная Windows: ни одного процесса, причина названа до всякой копии', async () => {
    const { res, row, spawned, logged, home } = await runForgeTick({ provisioned: false })

    expect(spawned).toHaveLength(0)
    expect(res.failed).toMatchObject({ taskId: 'F-1', reason: 'missing_access' })
    expect(row.failureReason).toBe('missing_access')
    // СЛОВАМИ, а не «черновик не закоммичен»: без этой двери карточка обвинила бы работника.
    expect(row.failureDetail).toContain('workspace-write')
    expect(row.failureDetail).toContain(home)
    expect(logged.some((e) => e.type === 'task.refused' && String(e.detail).includes('codex sandbox setup'))).toBe(true)
    // Копию для этой попытки даже не заказывали — отказ стоит ноль процессов И ноль провизий.
    expect(logged.some((e) => e.type === 'task.worktree_materialized_missing')).toBe(false)
  })

  it('провизированная Windows: попытка идёт, и на её строке лежит команда с песочницей', async () => {
    const { row, spawned } = await runForgeTick({ provisioned: true })

    expect(spawned).toHaveLength(1) // отказ не превратил полосу в выключенную
    // Дальше эта попытка честно упрётся в свой гейт (черновика в копии нет) — вопрос случая не
    // в её исходе, а в том, что ЧЕМ ЕЁ ЗАПУСКАЛИ теперь стоит на строке у ЛЮБОГО исхода.
    expect(row.spawn.bin).toBe('codex')
    expect(row.spawn.args).toEqual(spawned[0].args)
    expect(row.spawn.sandbox).toBe('workspace-write')
  })
})

// ═══════════ ПРАВО ПИСАТЬ БЕЗ КАТАЛОГА, В КОТОРЫЙ СДАЮТ, — ЭТО ПОЛОВИНА ПРАВА ══════════════
//
// ЧТО СЛОМАНО БЕЗ ЭТОГО. `workspace-write` открывает на запись РАБОЧИЙ КАТАЛОГ и ничего больше.
// А копия попытки — РАБОЧЕЕ ДЕРЕВО git: её `.git` не каталог, а файл-указатель, и индекс,
// ссылки и объекты лежат в основном репозитории, СНАРУЖИ копии. Поэтому сессия честно правила
// файлы и упиралась в запрет на `git add`; попытка уходила как «нет квитанции», и на карточке
// был виноват работник, сделавший всё, что мог (замерено 01.09.2026). Решение основателя
// 02.09.2026: кодекс — работник уровня Опуса/Фейбла и делает всё идентично; соседняя полоса
// ходит вообще без песочницы.
//
// УТВЕРЖДЕНИЕ ЗДЕСЬ — ПРО ШОВ, А НЕ ПРО ФУНКЦИЮ: git настоящий, копия — настоящее рабочее
// дерево, и вопрос ровно один — доехал ли до сборщика спавна тот каталог, без которого работу
// нельзя сдать. Границу это не снимает: называется ОДИН каталог, `danger-full-access`
// по-прежнему отклонён структурно.
describe('копия — рабочее дерево: git-каталог снаружи её едет в границу запуска', () => {
  it('пишущая задача: названы ОБА каталога — общий и свой каталог копии, — и оба СНАРУЖИ её', async () => {
    const { builtWith, copy, workDir, spawned } = await runTick({ provisioned: true, worktreeCopy: true })

    expect(spawned).toHaveLength(1)
    const roots = ((builtWith[0].writableRoots as string[]) ?? []).map(samePlace)
    const { gitDir, ownGitDir } = copy as { gitDir: string; ownGitDir: string }
    // ОБЩИЙ каталог — там объекты и ссылки; СВОЙ каталог копии — там индекс и HEAD, то есть
    // ровно то, что трогает `git add`. Вложенность второго в первый не повод его не называть:
    // «писаемый корень» — договор с чужим кодом, а не наше рассуждение о деревьях.
    expect(roots).toContain(samePlace(gitDir))
    expect(roots).toContain(samePlace(ownGitDir))
    // …и ХРАНИЛИЩЕ ОБЪЕКТОВ общего каталога: раздача прав идёт списком, а не деревом, и
    // подкаталог, которого в списке нет, остаётся при прежних правах — на нём и падало чтение.
    expect(roots).toContain(samePlace(join(gitDir, 'objects')))
    expect(roots).toHaveLength(3)
    // …и все ВНЕ копии — то есть песочница рабочего каталога их не покрывает, ради чего всё это.
    for (const r of roots) expect(r.startsWith(`${samePlace(workDir)}/`)).toBe(false)
  })

  it('оба пути доезжают до [sandbox_workspace_write] writable_roots — не до промежуточного списка', async () => {
    const { builtWith, copy } = await runTick({ provisioned: true, worktreeCopy: true })

    // ЧИТАТЕЛЬ НАСТОЯЩИЙ: тот же `codexConfigSeed`, которым дом задачи пишет свой `config.toml`,
    // получает РОВНО то, что тик отдал сборщику аргументов. Список, доехавший до опций и не
    // доехавший до текста конфига, — это «вычислено», а не «подключено».
    const toml = codexConfigSeed({ writableRoots: builtWith[0].writableRoots as string[] })
    const { gitDir, ownGitDir } = copy as { gitDir: string; ownGitDir: string }
    expect(toml).toContain('[sandbox_workspace_write]')
    const rootsLine = toml.split('\n').find((l) => l.startsWith('writable_roots = ')) ?? ''
    // Прочитано КАК ЧИТАТЕЛЬ: строки TOML разбираются обратно, экранирование снимается. Так
    // утверждение говорит о путях, а не о том, как они записаны, — и всё равно ловит писателя,
    // забывшего удвоить обратный слэш Windows.
    const declared = (rootsLine.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((q) =>
      samePlace(q.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"')),
    )
    expect(declared).toContain(samePlace(gitDir))
    expect(declared).toContain(samePlace(ownGitDir))
    expect(declared).toContain(samePlace(join(gitDir, 'objects')))
  })

  it('обычный клон: два вопроса git отвечают одно и то же — корень один, и при нём его объекты', async () => {
    const { builtWith, workDir } = await runTick({ provisioned: true })

    const roots = ((builtWith[0].writableRoots as string[]) ?? []).map(samePlace)
    expect(roots).toEqual([`${samePlace(workDir)}/.git`, `${samePlace(workDir)}/.git/objects`])
  })

  it('git молчит → корней нет, спавн идёт прежним, а промах лежит в журнале', async () => {
    const { builtWith, spawned, logged } = await runTick({ provisioned: true, failGitDirs: true })

    expect(spawned).toHaveLength(1) // отказ убил бы и полосу Claude, которая этот список не читает
    expect(builtWith[0].writableRoots).toBeUndefined()
    expect(logged.some((e) => e.type === 'task.copy_git_dir_unknown')).toBe(true)
  })

  it('git ответил на один вопрос из двух — ответ второго всё равно едет: половина лучше нуля', async () => {
    const { builtWith, copy, logged } = await runTick({
      provisioned: true,
      worktreeCopy: true,
      failGitCommonDirOnly: true,
    })

    const roots = ((builtWith[0].writableRoots as string[]) ?? []).map(samePlace)
    expect(roots).toEqual([samePlace((copy as { ownGitDir: string }).ownGitDir)])
    expect(logged.some((e) => e.type === 'task.copy_git_dir_unknown')).toBe(true)
  })

  it('вторая дверь спавна — кузница — получает те же каталоги, а не остаётся без них', async () => {
    const { builtWith, copy, spawned } = await runForgeTick({ provisioned: true, worktreeCopy: true })

    expect(spawned).toHaveLength(1)
    const roots = ((builtWith[0].writableRoots as string[]) ?? []).map(samePlace)
    const { gitDir, ownGitDir } = copy as { gitDir: string; ownGitDir: string }
    expect(roots).toContain(samePlace(gitDir))
    expect(roots).toContain(samePlace(ownGitDir))
    expect(roots).toContain(samePlace(join(gitDir, 'objects')))
  })
})

// ═══════════ ЖУРНАЛ ПЕСОЧНИЦЫ ПЕРЕЖИВАЕТ ДОМ, В КОТОРОМ ЛЕЖАЛ ══════════════════════════════
//
// ЧТО БЫЛО СЛОМАНО. Помощник песочницы ведёт единственную запись о том, какие права он раздал и
// какие запреты положил, — и ведёт её В ДОМЕ ЗАДАЧИ, который закрытие попытки выметает целиком.
// То есть улику, по которой разбирают «почему у работника не получилось», уничтожал тот же
// `finally`, что и мусор: разбор 03.09.2026 пришлось вести по дому СОСЕДНЕЙ задачи, случайно
// пережившей свою, — от самой пробы не осталось ни строки, и обе догадки о причине
// («не запрет ли чтения?») нечем было ни подтвердить, ни опровергнуть.
//
// Утверждения ниже — про продукт: настоящий тик, настоящая уборка, и вопрос ровно один —
// доезжают ли строки песочницы до журнала, который никто не выметает.
describe('дом задачи выметается — строки песочницы о правах остаются у оператора', () => {
  it('строки про раздачу прав и запреты уходят в журнал демона ДО того, как дом убран', async () => {
    const { logged, home } = await runTick({
      provisioned: true,
      worktreeCopy: true,
      sandboxJournal: true,
    })

    const kept = logged.find((e) => e.type === 'task.codex_sandbox_journal')
    expect(kept).toBeTruthy()
    const lines = (kept?.lines as string[]) ?? []
    expect(lines.some((l) => l.includes('granting write ACE'))).toBe(true)
    expect(lines.some((l) => l.includes('applied deny ACE'))).toBe(true)
    // Строка запуска команды — не про права, и в выжимку не идёт: журнал оператора читают глазами.
    expect(lines.some((l) => l.includes('START: git commit'))).toBe(false)
    // …а дома, из которого это снято, на диске уже нет — снимали ДО уборки, а не после.
    expect(existsSync(home as string)).toBe(false)
    expect(logged.some((e) => e.type === 'task.codex_home_discarded')).toBe(true)
  })

  it('счёт запретов чтения назван числом — вопрос «не запрет ли закрыл объекты» закрывается им', async () => {
    const { logged } = await runTick({ provisioned: true, worktreeCopy: true, sandboxJournal: true })

    const kept = logged.find((e) => e.type === 'task.codex_sandbox_journal')
    // Ноль — это «запретов чтения не ставили вовсе», и это ответ, а не отсутствие ответа.
    expect(kept?.denyReadPaths).toBe(0)
  })

  it('журнала нет вовсе (машина без песочницы) → и записи нет: шума на каждую попытку не будет', async () => {
    const { logged } = await runTick({ provisioned: true, worktreeCopy: true })

    expect(logged.some((e) => e.type === 'task.codex_sandbox_journal')).toBe(false)
    expect(logged.some((e) => e.type === 'task.codex_home_discarded')).toBe(true)
  })
})

// ═══════════ И ВСЁ РАВНО НЕ ДАЁТ: ЗАПРЕТ СИЛЬНЕЕ РАЗРЕШЕНИЯ ════════════════════════════════
//
// ЧТО ЗАМЕРЕНО 03.09.2026 ЖИВОЙ ПРОБОЙ ЧЕРЕЗ ДЕМОНА, и почему предыдущий раздел — это ещё не
// починка. В доме задачи стоял конфиг с общим git-каталогом в `writable_roots`, а журнал
// песочницы этой самой попытки читается так: сперва `granting write ACE` по названным корням,
// а СЛЕДОМ `applied deny ACE to protect …\.git\worktrees\<копия>` — на подкаталог УЖЕ
// разрешённого корня. В правах Windows запрет сильнее разрешения: сессия написала файл и
// получила `Permission denied` на `index.lock`. Тот же журнал показывает такой же запрет на
// `.git` ОБЫЧНОГО клона — значит песочница закрывает служебный каталог git как класс, и
// никакой список корней этого не отменяет. Снять запрет нечем: его ставит помощник установки,
// поставляемый вместе с CLI провайдера.
//
// ПОЭТОМУ КОММИТ ДЕЛАЕТ ХОЗЯИН — демон, снаружи песочницы, после сессии, на ветке работника.
// Утверждения ниже — про продукт, а не про файлы этой работы: настоящий git, настоящая копия
// как рабочее дерево, настоящий тик, и вопрос ровно один — доходит ли работа сессии до ветки,
// на которой её ждёт гейт.
describe('песочница запретила индекс — коммит за работника делает демон', () => {
  it('файлы сессии не закоммичены → на ветке появляется РОВНО ОДИН коммит с ними, и попытка зелёная', async () => {
    const { res, logged, workDir, copy } = await runTick({
      provisioned: true,
      worktreeCopy: true,
      emptyBranch: true,
      sessionLeaves: { 'docs/probe-codex-write.md': 'проба записи\n' },
    })

    // ДО ПОЧИНКИ ЭТО БЫЛО `dirty_tree` И НОЛЬ КОММИТОВ — ровно то, чем кончилась живая проба.
    const log = git(['log', '--oneline', `${copy.base}..HEAD`], workDir).trim().split('\n').filter(Boolean)
    expect(log).toHaveLength(1)
    const files = git(['show', '--name-only', '--format=', 'HEAD'], workDir).trim()
    expect(files).toContain('docs/probe-codex-write.md')
    // Работы работника в дереве больше нет — она СДАНА, и гейт видит сдачу, а не пустую попытку.
    // (Обстановка, которую положил сам демон, остаётся неотслеживаемой — её не сдают.)
    expect(git(['status', '--porcelain', '-uall'], workDir)).not.toContain('docs/probe-codex-write.md')
    expect(res.completed).toBe('BL-1')
    // NEVER SILENT: чья рука поставила коммит — сказано в журнале оператора.
    expect(logged.some((e) => e.type === 'task.host_commit')).toBe(true)
  })

  it('слова коммита называют причину — человек читает историю, а не гадает, откуда взялся коммит', async () => {
    const { workDir } = await runTick({
      provisioned: true,
      worktreeCopy: true,
      emptyBranch: true,
      sessionLeaves: { 'docs/probe-codex-write.md': 'проба записи\n' },
    })

    const message = git(['log', '-1', '--format=%B'], workDir)
    expect(message).toContain('демоном за работника')
    expect(message).toMatch(/песочниц/i)
  })

  it('обстановка демона в коммит НЕ идёт: берётся то, что оставил работник, и только оно', async () => {
    const { workDir, copy } = await runTick({
      provisioned: true,
      worktreeCopy: true,
      emptyBranch: true,
      sessionLeaves: { 'docs/probe-codex-write.md': 'проба записи\n', 'task_context.md': 'снимок задачи\n' },
    })

    const files = git(['show', '--name-only', '--format=', 'HEAD'], workDir).trim().split('\n').filter(Boolean)
    expect(files).toEqual(['docs/probe-codex-write.md'])
    // …а снимок задачи так и остался неотслеживаемым — демон положил его, демон и уберёт.
    expect(git(['status', '--porcelain', '-uall'], workDir)).toContain('task_context.md')
    expect(copy.base).toBeTruthy()
  })

  it('имя файла написано не по-английски — работа всё равно доезжает до ветки', async () => {
    // По умолчанию git отдаёт такое имя восьмеричными escape-последовательностями в кавычках,
    // и путь, снятый с такой строки, не открывается ничем: работа потерялась бы молча.
    const { workDir } = await runTick({
      provisioned: true,
      worktreeCopy: true,
      emptyBranch: true,
      sessionLeaves: { 'docs/проба-записи.md': 'проба записи\n' },
    })

    const files = git(['-c', 'core.quotePath=false', 'show', '--name-only', '--format=', 'HEAD'], workDir).trim()
    expect(files).toContain('docs/проба-записи.md')
  })

  it('в копии нечего фиксировать → коммита нет вовсе: пустого «чтобы был» эта рука не делает', async () => {
    const { workDir, copy, logged } = await runTick({ provisioned: true, worktreeCopy: true })

    const log = git(['log', '--oneline', `${copy.base}..HEAD`], workDir).trim().split('\n').filter(Boolean)
    expect(log).toHaveLength(1) // тот единственный коммит, что был в копии до сессии
    expect(logged.some((e) => e.type === 'task.host_commit')).toBe(false)
  })

  it('не-Windows: песочницу держит ядро, запрета никто не ставит — рука хозяина молчит', async () => {
    const { logged, workDir } = await runTick({
      provisioned: true,
      platform: 'linux',
      worktreeCopy: true,
      emptyBranch: true,
      sessionLeaves: { 'docs/probe-codex-write.md': 'проба записи\n' },
    })

    expect(logged.some((e) => e.type === 'task.host_commit')).toBe(false)
    // Работа осталась несданной, и это ЧЕСТНО: там, где сессия могла закоммитить сама, забытый
    // коммит — ошибка работника, а не стена, и гейт обязан назвать её своим именем.
    expect(git(['status', '--porcelain', '-uall'], workDir)).toContain('docs/probe-codex-write.md')
  })

  it('вторая дверь спавна — кузница — получает ту же руку: черновик доезжает до гейта', async () => {
    // Каталог черновика — `.claude/agents/`, то есть РОВНО под префиксом, которым помечена
    // обстановка демона. Общее правило прошло бы мимо него; здесь каталог назван явно.
    const { workDir, logged } = await runForgeTick({
      provisioned: true,
      worktreeCopy: true,
      sessionLeaves: { '.claude/agents/lenta.md': '# черновик агента\n' },
    })

    expect(logged.some((e) => e.type === 'task.host_commit')).toBe(true)
    const files = git(['show', '--name-only', '--format=', 'HEAD'], workDir).trim()
    expect(files).toContain('.claude/agents/lenta.md')
  })
})
