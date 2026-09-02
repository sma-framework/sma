/**
 * work-shape.test.ts — ФОРМА РАБОТЫ: третий вопрос выходного гейта.
 *
 * Оба прежних гейта спрашивали, ЕСТЬ ли доказательство. Ни один не спрашивал, О ЧЁМ работа —
 * и 31.08.2026 на приёмке возвращённой пробы это стоило зелёного, удостоверяющего ничто:
 * работник, не нашедший предмета, создал заметку и тест из трёх дел, проверяющих, что эта
 * заметка существует, содержит нужное слово и отслеживается git. Тест не мог покраснеть ни от
 * одной поломки продукта. Сьют прошёл, квитанция была честная, ветка слилась.
 *
 * Здесь заперты оба распознавателя формы — сначала как ЧИСТЫЕ функции (дёшево и по одному
 * правилу за раз), потом на живом тике: слово, которым это кончается, обязано доехать до
 * строки реестра, иначе распознаватель существует только в тестах.
 *
 * ГРАНИЦА, КОТОРУЮ ЭТОТ СЬЮТ СТОРОЖИТ С ДВУХ СТОРОН: обычная работа — новый модуль со своим
 * тестом — самозамкнутой НЕ называется. Распознаватель, который краснеет на ней, был бы хуже
 * дыры, которую он закрывает, поэтому случай «модуль + тест» стоит здесь рядом с дефектом.
 */

import { describe, it, expect } from 'vitest'

import { selfReferentialTests, newTopLevelDirs } from '../src/policy/work-shape.mjs'
import { tick } from '../src/loop.mjs'
import { createMemoryQueue, FAIL_REASONS, REASON_LABELS, failureAwaitsAPerson } from '../src/queue/adapter.mjs'
import { resolveRoute } from '../src/policy/routing.mjs'

// ─────────────────────────── ЧИСТЫЕ РАСПОЗНАВАТЕЛИ ───────────────────────────

/** Тест из замеренного случая, буква в букву по смыслу: говорит только о собственном файле. */
const SELF_TEST_SRC = `
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const NOTE_REL = 'notes/proba-potolka.md'
const NOTE = join(REPO_ROOT, NOTE_REL)

describe('заметка', () => {
  it('лежит на диске', () => { expect(existsSync(NOTE)).toBe(true) })
  it('содержит слово', () => { expect(readFileSync(NOTE, 'utf8')).toContain('проба') })
  it('отслеживается git', () => {
    expect(execFileSync('git', ['ls-files', '--', NOTE_REL], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()).toBe(NOTE_REL)
  })
})
`

/** Обычная работа: новый модуль и тест, который его ПОДКЛЮЧАЕТ и проверяет поведение. */
const HONEST_TEST_SRC = `
import { describe, it, expect } from 'vitest'
import { widen } from '../src/policy/widen.mjs'

describe('widen', () => {
  it('расширяет', () => { expect(widen(1)).toBe(2) })
})
`

/**
 * ПРОВОД-ТЕСТ ЧЕРЕЗ ЗАПУСК ПРОЦЕССА: ни одного `import` дерева, зато настоящий скрипт продукта
 * запускается дочерним процессом с подставным драйвером, и читается то, что он напечатал.
 * Замерено 02.09.2026: именно такой тест сторож отклонил как самозамкнутый.
 */
const SPAWN_TEST_SRC = `
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = resolve(__dirname, '..', '..')
const DRIVE = join(ROOT, 'scripts', 'sma', 'ui-drive.mjs')
const FAILING = join(__dirname, 'fixtures', 'failing-ui-driver.mjs')

describe('ui-drive', () => {
  it('маскирует учётные данные во всём выводе', () => {
    const res = spawnSync(process.execPath, [DRIVE, '--driver', FAILING], { encoding: 'utf8' })
    expect(res.stdout).not.toContain('s3cret')
    expect(res.stderr).not.toContain('s3cret')
  })
})
`

/** Тот же запуск, но продукта в нём нет: работа запускает ТОЛЬКО собственный новый файл. */
const SPAWN_OWN_ONLY_SRC = `
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const OWN = join(__dirname, 'fixtures', 'failing-ui-driver.mjs')

describe('свой же файл', () => {
  it('запускается', () => {
    expect(spawnSync(process.execPath, [OWN], { encoding: 'utf8' }).status).toBe(1)
  })
})
`

/** Существующий тест продукта, который работа ПРАВИТ: он подключает модуль дерева. */
const EXISTING_PRODUCT_TEST_SRC = `
import { describe, it, expect } from 'vitest'
import { mask } from '../lib/ui-drive.mjs'

describe('mask', () => {
  it('прячет пароль', () => { expect(mask('s3cret')).toBe('***') })
})
`

/** Тест о ФАЙЛЕ, но о чужом: такой файл был до работы, и сломать его может кто угодно. */
const PRODUCT_FILE_TEST_SRC = `
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

describe('README', () => {
  it('называет версию', () => { expect(readFileSync('README.md', 'utf8')).toContain('SMA') })
})
`

describe('selfReferentialTests — тест, который может покраснеть только от самого себя', () => {
  it('красит замеренный случай: заметка + тест о её существовании', () => {
    const hit = selfReferentialTests({
      entries: [
        { status: 'A', path: 'notes/proba-potolka.md' },
        { status: 'A', path: 'scripts/sma/__tests__/notes-proba-potolka.test.ts' },
      ],
      readFile: (p: string) => (p.endsWith('.test.ts') ? SELF_TEST_SRC : '# проба'),
      pathExists: () => false,
    })
    expect(hit).toBeTruthy()
    expect(hit!.files).toEqual(['scripts/sma/__tests__/notes-proba-potolka.test.ts'])
    // Улика в словах: человек обязан увидеть, КАКОЙ файл тест сторожит, не открывая исходник.
    expect(hit!.detail).toContain('notes/proba-potolka.md')
  })

  it('НЕ красит обычную работу: новый модуль и тест, который его подключает', () => {
    expect(
      selfReferentialTests({
        entries: [
          { status: 'A', path: 'daemon/src/policy/widen.mjs' },
          { status: 'A', path: 'daemon/__tests__/widen.test.ts' },
        ],
        readFile: (p: string) => (p.endsWith('.test.ts') ? HONEST_TEST_SRC : 'export const widen = (n) => n + 1'),
        pathExists: () => false,
      }),
    ).toBeNull()
  })

  it('НЕ красит тест о файле, которого эта работа не добавляла', () => {
    expect(
      selfReferentialTests({
        entries: [{ status: 'A', path: 'daemon/__tests__/readme.test.ts' }],
        readFile: () => PRODUCT_FILE_TEST_SRC,
        // README.md существует в копии и этой работой не добавлен — значит тест говорит о продукте
        pathExists: (p: string) => p === 'README.md',
      }),
    ).toBeNull()
  })

  it('НЕ судит изменённый тест — только ДОБАВЛЕННЫЙ этой же работой', () => {
    expect(
      selfReferentialTests({
        entries: [{ status: 'M', path: 'scripts/sma/__tests__/notes-proba-potolka.test.ts' }],
        readFile: () => SELF_TEST_SRC,
        pathExists: () => false,
      }),
    ).toBeNull()
  })

  it('называет ФАЙЛ, причину и выход словами — человеку не надо открывать исходник', () => {
    const hit = selfReferentialTests({
      entries: [
        { status: 'A', path: 'notes/proba-potolka.md' },
        { status: 'A', path: 'scripts/sma/__tests__/notes-proba-potolka.test.ts' },
      ],
      readFile: (p: string) => (p.endsWith('.test.ts') ? SELF_TEST_SRC : '# проба'),
      pathExists: () => false,
    })
    expect(hit!.detail).toContain('scripts/sma/__tests__/notes-proba-potolka.test.ts')
    expect(hit!.detail).toContain('добавлены этой же работой')
    // Отказ без выхода — это тупик: второй заход иначе жжёт ходы на угадывание.
    expect(hit!.detail).toContain('ВЫХОД')
    expect(hit!.detail).toContain('import')
    expect(hit!.detail).toContain('запустите файл продукта процессом')
  })

  it('МОЛЧИТ на нечитаемом файле, а не обвиняет', () => {
    expect(
      selfReferentialTests({
        entries: [{ status: 'A', path: 'daemon/__tests__/x.test.ts' }],
        readFile: () => {
          throw new Error('EACCES')
        },
        pathExists: () => false,
      }),
    ).toBeNull()
  })
})

describe('подключение продукта — не только import: запуск процессом и все тесты работы вместе', () => {
  /** Копия, в которой скрипт продукта лежит там, куда тест и целится. */
  const TREE = (p: string) => p === 'scripts/sma/ui-drive.mjs' || p === 'scripts/sma/lib/ui-drive.mjs'

  it('spawn-тест продукта ПРОХОДИТ сторожа: запуск файла дерева — это подключение', () => {
    expect(
      selfReferentialTests({
        entries: [
          { status: 'A', path: 'scripts/sma/__tests__/ui-drive-output.test.ts' },
          { status: 'A', path: 'scripts/sma/__tests__/fixtures/failing-ui-driver.mjs' },
        ],
        readFile: (p: string) => (p.endsWith('.test.ts') ? SPAWN_TEST_SRC : 'process.exit(1)'),
        pathExists: (p: string) => TREE(p),
      }),
    ).toBeNull()
  })

  it('тест-про-себя НЕ проходит: тот же запуск, но продукта в нём нет — только свой новый файл', () => {
    const hit = selfReferentialTests({
      entries: [
        { status: 'A', path: 'scripts/sma/__tests__/own.test.ts' },
        { status: 'A', path: 'scripts/sma/__tests__/fixtures/failing-ui-driver.mjs' },
      ],
      readFile: (p: string) => (p.endsWith('.test.ts') ? SPAWN_OWN_ONLY_SRC : 'process.exit(1)'),
      pathExists: (p: string) => TREE(p),
    })
    expect(hit).toBeTruthy()
    expect(hit!.files).toEqual(['scripts/sma/__tests__/own.test.ts'])
  })

  it('правленый существующий тест продукта снимает вопрос со ВСЕЙ работы', () => {
    expect(
      selfReferentialTests({
        entries: [
          { status: 'A', path: 'notes/proba-potolka.md' },
          { status: 'A', path: 'scripts/sma/__tests__/notes-proba-potolka.test.ts' },
          { status: 'M', path: 'scripts/sma/__tests__/ui-drive.test.ts' },
        ],
        readFile: (p: string) => {
          if (p.endsWith('ui-drive.test.ts')) return EXISTING_PRODUCT_TEST_SRC
          if (p.endsWith('.test.ts')) return SELF_TEST_SRC
          return '# проба'
        },
        pathExists: (p: string) => TREE(p),
      }),
    ).toBeNull()
  })

  it('правленый тест, которого не прочесть, снимает вопрос: судить нечем', () => {
    expect(
      selfReferentialTests({
        entries: [
          { status: 'A', path: 'notes/proba-potolka.md' },
          { status: 'A', path: 'scripts/sma/__tests__/notes-proba-potolka.test.ts' },
          { status: 'M', path: 'scripts/sma/__tests__/ui-drive.test.ts' },
        ],
        readFile: (p: string) => {
          if (p.endsWith('ui-drive.test.ts')) throw new Error('EACCES')
          return p.endsWith('.test.ts') ? SELF_TEST_SRC : '# проба'
        },
        pathExists: () => false,
      }),
    ).toBeNull()
  })

  it('правленый файл, который тестом НЕ является, обвинения не снимает', () => {
    const hit = selfReferentialTests({
      entries: [
        { status: 'A', path: 'notes/proba-potolka.md' },
        { status: 'A', path: 'scripts/sma/__tests__/notes-proba-potolka.test.ts' },
        { status: 'M', path: 'README.md' },
      ],
      readFile: (p: string) => (p.endsWith('.test.ts') ? SELF_TEST_SRC : '# проба'),
      pathExists: () => false,
    })
    expect(hit!.files).toEqual(['scripts/sma/__tests__/notes-proba-potolka.test.ts'])
  })
})

describe('newTopLevelDirs — из чего состоит продукт, решает человек', () => {
  const BASE = ['daemon', 'docs', 'scripts', 'README.md', 'package.json']

  it('называет каталог верхнего уровня, которого в базе не было', () => {
    expect(
      newTopLevelDirs({
        entries: [
          { status: 'A', path: 'notes/proba-potolka.md' },
          { status: 'A', path: 'scripts/sma/__tests__/notes-proba-potolka.test.ts' },
        ],
        baseTopLevel: BASE,
      }),
    ).toEqual(['notes'])
  })

  it('молчит о новых файлах внутри уже существующих каталогов', () => {
    expect(
      newTopLevelDirs({
        entries: [{ status: 'A', path: 'daemon/src/policy/widen.mjs' }],
        baseTopLevel: BASE,
      }),
    ).toEqual([])
  })

  it('не считает каталогом файл, положенный в корень', () => {
    expect(newTopLevelDirs({ entries: [{ status: 'A', path: 'NOTES.md' }], baseTopLevel: BASE })).toEqual([])
  })

  it('молчит, когда список базы неизвестен — судить нечем', () => {
    expect(newTopLevelDirs({ entries: [{ status: 'A', path: 'notes/x.md' }], baseTopLevel: [] })).toEqual([])
  })

  it('не считает мебель демона: .claude, .sma, node_modules', () => {
    expect(
      newTopLevelDirs({
        entries: [
          { status: 'A', path: '.claude/memory/drafts/lesson.md' },
          { status: 'A', path: '.sma/state.json' },
          { status: 'A', path: 'node_modules/x/index.js' },
        ],
        baseTopLevel: BASE,
      }),
    ).toEqual([])
  })
})

// ─────────────────────────── ЖИВОЙ ТИК ───────────────────────────

const mkClock = (start = 1_700_000_000_000) => {
  const s = { now: start }
  return { clock: () => s.now, advance: (ms: number) => (s.now += ms) }
}

const WORKERS = [{ id: 'max-2', lane: 'prod', provider: 'claude', account: { configDir: '/claude' }, enabled: true }]

const NUL = String.fromCharCode(0)
const nameStatus = (rows: [string, string][]) => rows.map(([s, p]) => `${s}${NUL}${p}`).join(NUL) + NUL

function makeSpawnWorker(lines: string[]) {
  return (spec: any) => {
    for (const l of lines) spec.onLine?.(l)
    spec.onExit?.({ code: 0, signal: null })
    return { pid: 1, kill: () => {} }
  }
}

/**
 * Копия, о которой git говорит ровно то, что задал тест. `files` — карта «путь в копии →
 * содержимое»; всё, чего в ней нет, для демона не существует, как и на настоящем диске.
 */
function makeDeps({ adapter, clock, diff, files, commits = '2', lines, reverify }: any) {
  const journal: any[] = []
  const store = new Map<string, string>(Object.entries(files ?? {}))
  const key = (p: string) => String(p).replace(/\\/g, '/')
  return {
    journal,
    deps: {
      adapter,
      journal: (e: any) => journal.push(e),
      ledger: { recordAttempt: (a: any) => a, readAttempts: () => [] },
      config: { workers: WORKERS, agingHours: 24, backlogScanMinutes: 60, repoDir: '/repo', pipeline: { enabled: true } },
      routing: { resolveRoute },
      windows: () => true,
      buildArgs: () => ({ bin: 'exec', args: ['-'], env: {}, prompt: 'p' }),
      verbRunner: async (_bin: string, argv: string[]) => {
        const verb = argv[1]
        if (verb === 'preflight') return { code: 0, stdout: JSON.stringify({ verdict: 'not-built' }) }
        if (verb === 'worktree') {
          return { code: 0, stdout: JSON.stringify({ ok: true, path: '/wt/shape', branch: 'wt/shape', expectedBase: 'base0' }) }
        }
        if (verb === 'reverify') {
          return reverify ?? { code: 0, stdout: JSON.stringify({ verdict: 'green', receiptRef: 'reverify:green' }) }
        }
        return { code: 0, stdout: '{}' }
      },
      execGit: (argv: string[]) => {
        if (argv[0] === 'rev-list') return commits
        if (argv[0] === 'status') return ''
        if (argv.includes('diff')) return diff ?? ''
        if (argv[0] === 'ls-tree') return ['daemon', 'docs', 'scripts', 'README.md', 'package.json'].join('\n')
        if (argv[0] === 'cat-file') return 'commit'
        return ''
      },
      fsImpl: {
        existsSync: (p: string) => store.has(key(p)),
        readFileSync: (p: string) => {
          const v = store.get(key(p))
          if (v === undefined) throw new Error(`ENOENT ${p}`)
          return v
        },
        readdirSync: () => [],
        mkdirSync: () => {},
        writeFileSync: () => {},
        rmSync: () => {},
      },
      spawnWorker: makeSpawnWorker(lines ?? ['APPROACH_NOTE: прямой путь', 'LESSON_NONE: тестовый работник']),
      report: async () => {},
      clock,
    },
  }
}

const TASK = { source: 'backlog', title: 't', lane: 'prod', storyPoints: 2, acceptance: 'a' }

describe('выходной гейт: форма работы доезжает до строки реестра', () => {
  it('самозамкнутый тест краснит зелёный сьют — fail(self_referential_test)', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-SELF', ...TASK })
    const { deps, journal } = makeDeps({
      adapter,
      clock: c.clock,
      diff: nameStatus([
        ['A', 'scripts/sma/__tests__/notes-proba.test.ts'],
        ['A', 'scripts/sma/notes/proba.md'],
      ]),
      files: {
        '/wt/shape/scripts/sma/__tests__/notes-proba.test.ts': SELF_TEST_SRC.replace(/notes\/proba-potolka\.md/g, 'scripts/sma/notes/proba.md'),
        '/wt/shape/scripts/sma/notes/proba.md': '# проба',
      },
    })
    const res = await tick(deps)

    expect(res.failed?.reason).toBe('self_referential_test')
    const [row] = await adapter.list({})
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('self_referential_test')
    // НИКОГДА МОЛЧА: оператор обязан прочитать, ЧТО именно было отклонено, не открывая поток.
    expect(journal.some((e) => e.type === 'task.self_referential_test')).toBe(true)
  })

  it('новый каталог верхнего уровня — ВОПРОС человеку: строка ждёт и не перевыдаётся', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-DIR', ...TASK })
    // КАКОЙ ДВЕРЬЮ ЗАКРЫЛИ СТРОКУ — наблюдается прямо: `fail` перевыдаваема, `parkForPerson`
    // нет, и в памяти обе оставляют одинаковую строку. Различает их только сам вызов.
    const parked: string[] = []
    const inner = adapter.parkForPerson
    adapter.parkForPerson = async (id: string, reason: string, o: any) => {
      parked.push(`${id}:${reason}`)
      return inner(id, reason, o)
    }
    const { deps, journal } = makeDeps({
      adapter,
      clock: c.clock,
      diff: nameStatus([['A', 'notes/proba.md']]),
      files: { '/wt/shape/notes/proba.md': '# проба' },
    })
    const res = await tick(deps)

    expect(res.failed?.reason).toBe('new_top_level_dir')
    expect(res.failed?.detail).toContain('notes')
    const [row] = await adapter.list({})
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('new_top_level_dir')
    // За этим концом нет следующей попытки: перевыдача завела бы тот же каталог второй раз.
    expect(failureAwaitsAPerson('new_top_level_dir')).toBe(true)
    expect(parked).toEqual(['BL-DIR:new_top_level_dir'])
    expect(journal.some((e) => e.type === 'task.new_top_level_dir')).toBe(true)
  })

  it('ИЗМЕРЕННЫЙ КРАСНЫЙ сильнее формы: тесты действительно красные — так и сказано', async () => {
    // Человеку, у которого красная перепроверка, «тест говорит о себе» не чинит ничего: сперва
    // измеренный факт о ветке, и только потом суждение о том, что этот факт удостоверяет.
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-RED', ...TASK })
    const { deps } = makeDeps({
      adapter,
      clock: c.clock,
      reverify: { code: 1, stdout: JSON.stringify({ verdict: 'red', receiptRef: 'reverify:red' }) },
      diff: nameStatus([['A', 'scripts/sma/__tests__/notes-proba.test.ts']]),
      files: {
        '/wt/shape/scripts/sma/__tests__/notes-proba.test.ts': SELF_TEST_SRC.replace(
          /notes\/proba-potolka\.md/g,
          'scripts/sma/__tests__/notes-proba.test.ts',
        ),
      },
    })
    const res = await tick(deps)
    expect(res.failed?.reason).toBe('tests_red')
  })

  it('провод-тест через запуск процесса проезжает гейт: работа не «о себе»', async () => {
    // Замеренный случай 02.09.2026 целиком: новый тест запускает настоящий скрипт продукта с
    // подставным падающим драйвером, ни одного import'а дерева в нём нет — и работа зелёная.
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-SPAWN', ...TASK })
    const { deps } = makeDeps({
      adapter,
      clock: c.clock,
      diff: nameStatus([
        ['A', 'scripts/sma/__tests__/ui-drive-output.test.ts'],
        ['A', 'scripts/sma/__tests__/fixtures/failing-ui-driver.mjs'],
        ['M', 'scripts/sma/ui-drive.mjs'],
      ]),
      files: {
        '/wt/shape/scripts/sma/__tests__/ui-drive-output.test.ts': SPAWN_TEST_SRC,
        '/wt/shape/scripts/sma/__tests__/fixtures/failing-ui-driver.mjs': 'process.exit(1)',
        '/wt/shape/scripts/sma/ui-drive.mjs': 'export {}',
      },
    })
    const res = await tick(deps)

    expect(res.failed?.reason).toBeUndefined()
    expect(res.completed).toBe('BL-SPAWN')
  })

  it('обычная работа внутри существующих каталогов проходит гейт как прежде', async () => {
    const c = mkClock()
    const adapter = createMemoryQueue({ clock: c.clock, expireMs: 300000 })
    await adapter.enqueue({ id: 'BL-OK', ...TASK })
    const { deps } = makeDeps({
      adapter,
      clock: c.clock,
      diff: nameStatus([
        ['A', 'daemon/src/policy/widen.mjs'],
        ['A', 'daemon/__tests__/widen.test.ts'],
      ]),
      files: {
        '/wt/shape/daemon/src/policy/widen.mjs': 'export const widen = (n) => n + 1',
        '/wt/shape/daemon/__tests__/widen.test.ts': HONEST_TEST_SRC,
      },
    })
    const res = await tick(deps)

    expect(res.completed).toBe('BL-OK')
    const [row] = await adapter.list({})
    expect(row.status).toBe('awaiting_approval')
  })
})

describe('словарь причин знает оба новых конца', () => {
  for (const word of ['self_referential_test', 'new_top_level_dir']) {
    it(`${word}: есть в таксономии и имеет подпись для карточки`, () => {
      expect(FAIL_REASONS, `слово ${word} не признано словарём`).toContain(word)
      expect(REASON_LABELS[word], `у слова ${word} нет подписи для карточки`).toBeTruthy()
    })
  }

  it('самозамкнутый тест НЕ называется «тесты красные» — это разные починки', () => {
    expect(REASON_LABELS.self_referential_test).not.toBe(REASON_LABELS.tests_red)
  })
})
