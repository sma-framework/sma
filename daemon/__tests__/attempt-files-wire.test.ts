/**
 * ЧТО ПОПЫТКА ИЗМЕНИЛА — ПРОВОД ОТ КОПИИ РАБОТНИКА ДО СТРОКИ, КОТОРУЮ ЧИТАЕТ ЧЕЛОВЕК.
 *
 * ЧТО ЭТОТ ФАЙЛ ДОКАЗЫВАЕТ И ЧЕМ ОН ОТЛИЧАЕТСЯ ОТ СОСЕДНЕГО. Рядом уже лежит сьют, который
 * утверждает, что функция списка правильно разбирает ответ git. Он был зелёным всё то время,
 * пока список никуда не доезжал: он уходил ОДНОЙ строкой в операторский лог — запись, которая
 * не переживает ни перезапуск, ни ротацию, ни месяц, — а замкнутый список ключей строки
 * попытки о нём не знал. Вычислено, записано и не подключено; авторский комментарий рядом с
 * вызовом прямо это признавал. Поэтому здесь ничего не считается: гоняется НАСТОЯЩИЙ тик по
 * НАСТОЯЩЕМУ временному проекту с НАСТОЯЩИМ git, а утверждается строка НА ДИСКЕ, прочитанная
 * настоящим читателем леджера.
 *
 * ЧЕТЫРЕ УТВЕРЖДЕНИЯ, И КАЖДОЕ — ПРО ПРОВОД, А НЕ ПРО РАСЧЁТ:
 *
 *   (1) строка попытки на диске несёт `files` и `deletions` — на ОБОИХ исходах. Провалившаяся
 *       попытка — ровно та, которую человек хочет откатить, и запись, которая есть только у
 *       успешной, бесполезна именно тогда, когда нужна;
 *   (2) то же самое на выходе, у которого НЕТ каталога прогона. Это и есть доказательство,
 *       что правка ОДНА: список берётся рядом с вердиктом паритета, в двух дверях записи,
 *       через которые проходят все двадцать три выхода, — а не привязан к каталогу, которого
 *       у раннего отказа не существует;
 *   (3) git спрошен РОВНО ОДИН раз за попытку, хотя спросить могли обе двери и строка лога;
 *   (4) правка, сделанная в обход инструментов правки, В СПИСКЕ ЕСТЬ — а в списке, собранном
 *       по именам инструментов, её нет и быть не может. Один прогон, два измерения рядом.
 *
 * ПОТОК КАДРОВ НЕ ВЫДУМАН. Фикстура — кадры, снятые с живого прогона этого демона; в ней есть
 * `Read` и `Bash` и НЕТ НИ ОДНОГО кадра инструмента правки. Это не подгонка под удобный
 * результат, а обычный вид сессии, которая правит файлы командами: словарь «файловых»
 * инструментов такую работу не видит в принципе.
 *
 * И GIT ЗДЕСЬ НАСТОЯЩИЙ. Урок этого дерева: подделка, которая отдаёт то, чего от неё ждут,
 * зелена всегда — в том числе в тот день, когда форму ответа знают неправильно.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tick } from '../src/loop.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'
import { createMemoryQueue } from '../src/queue/adapter.mjs'
import { recordAttempt, readAttempts, createAttemptLogWriter, readAttemptLog } from '../src/queue/attempt-ledger.mjs'
import { buildClaudeArgs } from '../src/runner/args.mjs'

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

/** НАСТОЯЩИЙ git — тот же вызов, что собирает production. */
const git = (args: string[], cwd: string) =>
  String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '')

/**
 * НАСТОЯЩАЯ ОБОЛОЧКА, а не эмуляция её через файловый интерфейс.
 *
 * Смысл случая именно в том, что правка сделана СРЕДСТВАМИ МАШИНЫ, а не инструментом правки:
 * работник, который зовёт `rm`, делает ровно это. Оболочка называется по системе, потому что
 * подделка одной из них ради «переносимости» вернула бы нас к тому, что мы и проверяем.
 */
const shell = ({ posix, win }: { posix: string; win: string }, cwd: string) =>
  process.platform === 'win32'
    ? execFileSync('powershell', ['-NoProfile', '-Command', win], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('sh', ['-c', posix], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

// ── кадры: настоящие, снятые с живого прогона ──────────────────────────────────────────────

const FIXTURE_WORKDIR = 'C:\\work\\.sma-worktrees\\t-1000'

const framesOf = (file: string, workDir: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', file), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const frame = JSON.parse(line)
      for (const block of frame.message?.content ?? []) {
        if (block && typeof block.input?.file_path === 'string') {
          block.input.file_path = block.input.file_path.split(FIXTURE_WORKDIR).join(workDir)
        }
      }
      return JSON.stringify(frame)
    })

const NOTE = 'APPROACH_NOTE: правки сделаны командами, не редактором'
const LESSON = 'LESSON_NONE: урока нет'
const PROMPT = 'сделай дело и оставь квитанцию'
const WORKER_ID = 'max-2'

const SPAWN_ENV = {
  CLAUDE_CONFIG_DIR: 'C:\\work\\.sma-accounts\\local-1',
  PATH: '/usr/bin',
}

const backlogTask = (over: any = {}) => ({
  id: 'BL-1',
  source: 'backlog',
  title: 'do the thing',
  lane: 'prod',
  priority: 0,
  storyPoints: 3,
  acceptance: 'green targeted tests + a reverify receipt',
  ...over,
})

const makeVerbRunner = (responses: Record<string, any>) => async (_bin: string, argsArray: string[]) => {
  const verb = argsArray[1]
  const r = responses[verb] ?? { code: 0, stdout: '{}' }
  return typeof r === 'function' ? r() : r
}

const GREEN_REVERIFY = {
  code: 0,
  stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:abc', diffStat: '+10 -2' }),
}
const RED_REVERIFY = { code: 1, stdout: JSON.stringify({ verdict: 'red' }) }

// ── КОПИЯ РАБОТНИКА: настоящий репозиторий, правки — В ОБХОД ИНСТРУМЕНТОВ ПРАВКИ ────────────

/**
 * Копия с известной базой и своей веткой, в которой сделаны ЧЕТЫРЕ правки, ни одну из которых
 * словарь «файловых» инструментов не может увидеть: файл удалён оболочкой, файл переписан по
 * месту, файл убран из индекса, файл переименован. Плюс добавлен файл с русским именем —
 * чтобы читаемость имени проверялась на всём пути, а не только в разборе.
 *
 * Добавление и удаление — ПО ИМЕНАМ. `git add -A` не используется даже во временном
 * репозитории: массовое добавление — ровно та привычка, которая в общем дереве уносит чужие
 * файлы, и тест не то место, где её стоит репетировать.
 */
const makeCopy = (prefix = 'sma-files-copy-') => {
  const dir = mkDir(prefix)
  git(['init', '-q', '.'], dir)
  git(['config', 'user.email', 'wire@test'], dir)
  git(['config', 'user.name', 'wire'], dir)
  git(['config', 'core.autocrlf', 'false'], dir)

  writeFileSync(join(dir, 'CLAUDE.md'), '# правила проекта\n', 'utf8')
  // СОДЕРЖИМОЕ здесь намеренно латиницей: замену по месту делает НАСТОЯЩАЯ оболочка, а у
  // оболочек разных систем разные представления о кодировке текста, который через них едет.
  // Проверяем мы не это — проверяем ИМЕНА, и русское имя ниже стоит там, где ему и место.
  writeFileSync(join(dir, 'rewritten.txt'), 'old value\n', 'utf8')
  writeFileSync(join(dir, 'doomed.txt'), 'this file is deleted by the shell\n', 'utf8')
  writeFileSync(join(dir, 'unstaged.txt'), 'this file leaves the index\n', 'utf8')
  writeFileSync(join(dir, 'oldname.txt'), 'this file is renamed\n', 'utf8')
  git(['add', 'CLAUDE.md', 'rewritten.txt', 'doomed.txt', 'unstaged.txt', 'oldname.txt'], dir)
  git(['commit', '-qm', 'база'], dir)
  const base = git(['rev-parse', 'HEAD'], dir).trim()

  git(['checkout', '-q', '-b', 'wt/BL-1'], dir)

  // (1) УДАЛЕНИЕ ОБОЛОЧКОЙ — `rm`. Ни один инструмент правки при этом не вызывается.
  shell({ posix: 'rm -f doomed.txt', win: 'Remove-Item -Force doomed.txt' }, dir)
  // (2) ЗАМЕНА ПО МЕСТУ — то, что работник делает потоковым редактором.
  shell(
    {
      posix: "sed -i 's/old/new/' rewritten.txt",
      win: "(Get-Content rewritten.txt) -replace 'old','new' | Set-Content rewritten.txt",
    },
    dir,
  )
  // (3) УБРАН ИЗ ИНДЕКСА — `git rm --cached`: файл остаётся на диске и исчезает из дерева.
  git(['rm', '-q', '--cached', 'unstaged.txt'], dir)
  // (4) ПЕРЕИМЕНОВАНИЕ.
  git(['mv', 'oldname.txt', 'newname.txt'], dir)
  // …и добавление файла с русским именем — путь до строки должен пережить и его.
  writeFileSync(join(dir, 'заметка.txt'), 'по-русски\n', 'utf8')

  git(['add', 'rewritten.txt', 'doomed.txt', 'заметка.txt'], dir)
  git(['commit', '-qm', 'работа, сделанная командами'], dir)
  return { dir, base }
}

// ── один настоящий тик ─────────────────────────────────────────────────────────────────────

/**
 * Тик по настоящему временному проекту. `projectDir` НАМЕРЕННО не репозиторий: так дверь
 * «ответа словами» честно отвечает «не знаю» (её счёт коммитов падает и ловится), и попытку
 * решает тот гейт, который и должен её решать.
 */
async function runTick(over: any = {}) {
  const projectDir = over.projectDir ?? mkDir('sma-files-proj-')
  const ledgerDir = over.ledgerDir ?? mkDir('sma-files-ledger-')
  const copy = over.copy ?? makeCopy()
  const workDir = copy.dir

  const lines: string[] = over.lines ?? [...framesOf('claude-stream-parity-green.ndjson', workDir), NOTE, LESSON]
  const c = mkClock()
  const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
  await adapter.enqueue(backlogTask())
  const logged: any[] = []

  const workers = [{ id: WORKER_ID, lane: 'prod', provider: 'claude', account: { configDir: '/x' }, enabled: true }]

  // ШОВ GIT СЧИТАЕТ САМ СЕБЯ. Не «сколько раз мы думаем, что спросили», а сколько вызовов
  // списка изменённых файлов на самом деле дошло до git за одну попытку.
  const gitCalls: string[][] = []
  const countingGit = (args: string[], opts: any = {}) => {
    gitCalls.push(args)
    return git(args, opts.cwd || workDir)
  }

  const deps: any = {
    adapter,
    ledger: {
      recordAttempt: (row: any) => recordAttempt(ledgerDir, row),
      readAttempts: (id: string) => readAttempts(ledgerDir, id),
      attemptLog: ({ attemptId }: any) => createAttemptLogWriter({ dir: ledgerDir, attemptId }),
    },
    config: {
      workers,
      agingHours: 24,
      backlogScanMinutes: 60,
      repoDir: projectDir,
      pipeline: { enabled: true },
      ...over.config,
    },
    routing: { resolveRoute },
    windows: () => true,
    projectDir: () => projectDir,
    buildArgs: () => ({ bin: 'claude', args: buildClaudeArgs({}), env: { ...SPAWN_ENV }, prompt: PROMPT }),
    verbRunner: makeVerbRunner({
      preflight: { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) },
      worktree: {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          path: workDir,
          branch: 'wt/BL-1',
          // БАЗА, КОТОРУЮ НАЗВАЛ ВЕРБ ПРОВИЗИИ — настоящий коммит настоящего репозитория:
          // именно от него считается всё, что попытка изменила.
          expectedBase: copy.base,
          materialized: [{ path: 'CLAUDE.md', mode: 'copy', files: 1, tracked: 0, current: 0, bytes: 812 }],
        }),
      },
      reverify: over.reverify ?? GREEN_REVERIFY,
    }),
    spawnWorker: (spec: any) => {
      for (const l of lines) spec.onLine?.(l)
      spec.onExit?.({ code: 0, signal: null })
      return { pid: 4242, kill: () => {} }
    },
    report: async () => {},
    clock: c.clock,
    journal: (e: any) => logged.push(e),
    execGit: countingGit,
    ...over.deps,
  }

  const res = await tick(deps)
  return {
    res,
    projectDir,
    ledgerDir,
    workDir,
    base: copy.base,
    logged,
    gitCalls,
    runDir: join(projectDir, '.sma', 'runs', 'BL-1_1'),
  }
}

/** Строка попытки, прочитанная С ДИСКА настоящим читателем леджера, — а не объект в памяти. */
const rowOnDisk = (ledgerDir: string) => {
  const rows = readAttempts(ledgerDir, 'BL-1')
  return rows[rows.length - 1]
}

const pathsOf = (row: any) => (row.files || []).map((f: any) => f.path).sort()

// ═══════════ ОБА ИСХОДА: СТРОКА НА ДИСКЕ НЕСЁТ СПИСОК ══════════════════════════════════════

describe('строка попытки несёт список изменённого — на обоих исходах', () => {
  it('оба исхода: принятая попытка — список и исчезнувшие лежат в строке НА ДИСКЕ', async () => {
    const { res, ledgerDir } = await runTick()
    expect(res.completed).toBe('BL-1')

    const row = rowOnDisk(ledgerDir)
    expect(row.outcome).toBe('completed')
    expect(pathsOf(row)).toContain('rewritten.txt')
    expect(pathsOf(row)).toContain('newname.txt')
    expect(pathsOf(row)).toContain('заметка.txt')
    // Исчезнувшее — ОТДЕЛЬНЫМ ключом: «удалён» и «изменён» разные новости.
    expect(row.deletions).toContain('doomed.txt')
    expect(row.deletions).toContain('unstaged.txt')
    expect(row.deletions).toContain('oldname.txt')
    // …и точка отката рядом, в той же строке.
    expect(row.base).toBeTruthy()
    expect(row.branch).toBe('wt/BL-1')
  })

  it('оба исхода: ПРОВАЛЕННАЯ попытка несёт ровно тот же список — её и хотят откатить', async () => {
    const { res, ledgerDir } = await runTick({ reverify: RED_REVERIFY })
    expect(res.failed).toBeTruthy()

    const row = rowOnDisk(ledgerDir)
    expect(row.outcome).toBe('failed')
    expect(pathsOf(row)).toContain('rewritten.txt')
    expect(row.deletions).toContain('doomed.txt')
    expect(row.deletions).toContain('oldname.txt')
    expect(row.base).toBeTruthy()
  })

  it('русское имя доезжает до строки читаемым, а не восьмеричными последовательностями', async () => {
    const { ledgerDir } = await runTick()
    const raw = readFileSync(join(ledgerDir, 'BL-1.jsonl'), 'utf8')
    expect(raw).toContain('заметка.txt')
    expect(/\\3[0-9]{2}/.test(raw)).toBe(false)
  })
})

// ═══════════ ВЫХОД БЕЗ КАТАЛОГА ПРОГОНА — ДОКАЗАТЕЛЬСТВО «ОДНОЙ ПРАВКИ» ════════════════════

describe('одна правка, а не двадцать три: список не привязан к каталогу прогона', () => {
  it('без каталога прогона: ранний отказ пишет строку со списком всё равно', async () => {
    // Зеркало личного слоя отказывает — попытка умирает ДО того, как каталог прогона создан.
    // Если бы список висел на каталоге, здесь он потерялся бы молча; в этом и весь смысл.
    const { res, ledgerDir, runDir } = await runTick({
      deps: {
        mirrorPersonalLayer: () => {
          throw new Error('настройки аккаунта не записались')
        },
      },
    })

    expect(res.failed).toMatchObject({ taskId: 'BL-1', reason: 'personal_layer_error' })
    expect(existsSync(runDir)).toBe(false) // каталога прогона нет — и это условие случая

    const row = rowOnDisk(ledgerDir)
    expect(row.runDir).toBeUndefined()
    expect(pathsOf(row)).toContain('rewritten.txt')
    expect(row.deletions).toContain('doomed.txt')
  })

  it('один раз: git спрошен о списке РОВНО однажды, хотя спросить могли обе двери и лог', async () => {
    const { gitCalls } = await runTick()
    const listCalls = gitCalls.filter((a) => a.includes('--name-status'))
    expect(listCalls).toHaveLength(1)
    // И это был вызов с нулевыми разделителями и выключенным квотированием — провод, а не намерение.
    expect(listCalls[0]).toContain('-z')
    expect(listCalls[0]).toContain('core.quotepath=false')
  })

  it('старые записи молчат: строка без этих ключей читается как раньше, без ошибки', () => {
    const ledgerDir = mkDir('sma-files-old-')
    recordAttempt(ledgerDir, { taskId: 'BL-1', attempt: 1, outcome: 'completed', base: 'abc123' })
    const rows = readAttempts(ledgerDir, 'BL-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].files).toBeUndefined()
    expect(rows[0].deletions).toBeUndefined()
    expect(rows[0].base).toBe('abc123')
  })
})

// ═══════════ КОНТРАСТ: ОДИН ПРОГОН, ДВА ИЗМЕРЕНИЯ РЯДОМ ════════════════════════════════════

describe('правка через оболочку видна в строке — и невидима списку из имён инструментов', () => {
  it('через оболочку: список в строке несёт все четыре правки, а список из инструментов ПУСТ', async () => {
    const { res, ledgerDir } = await runTick()
    expect(res.completed).toBe('BL-1')

    // ИЗМЕРЕНИЕ ПЕРВОЕ — строка попытки с диска, источник которой git.
    const row = rowOnDisk(ledgerDir)
    const fromGit = [...pathsOf(row), ...row.deletions].sort()

    // ИЗМЕРЕНИЕ ВТОРОЕ — тот же прогон, но список, собранный по ИМЕНАМ ИНСТРУМЕНТОВ.
    const log = readAttemptLog({ dir: ledgerDir, attemptId: 'BL-1#1' })
    const fromTools = (log.digest && log.digest.filesChanged) || []

    // Все четыре правки, сделанные командами, в строке ЕСТЬ.
    expect(fromGit).toContain('rewritten.txt') // переписан по месту
    expect(fromGit).toContain('doomed.txt') // удалён оболочкой
    expect(fromGit).toContain('unstaged.txt') // убран из индекса
    expect(fromGit).toContain('newname.txt') // переименован
    expect(fromGit).toContain('oldname.txt') // …и старое имя названо исчезнувшим

    // А список из имён инструментов ПУСТ — не «неполон»: ни один инструмент правки не звался.
    expect(fromTools).toEqual([])
    // При этом поток кадров прочитан и не пуст: измерение второе провалилось не от тишины.
    expect(log.entries.length).toBeGreaterThan(0)
    expect(log.digest).toBeTruthy()
    expect((log.digest.tools || []).map((t: any) => t.name)).not.toContain('Edit')
    expect((log.digest.tools || []).map((t: any) => t.name)).not.toContain('Write')
  })
})
